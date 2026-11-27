import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  type TrustTier,
  type VerifiedExecution,
  evaluateExecutionPolicy
} from "../trust/ExecutionTrust.ts"

export const DEFAULT_CLOUD_OBJECT_STORE_ENDPOINT = "https://build.smithers.sh"
export const DEFAULT_ARTIFACTS_INTERNAL_ENDPOINT = "http://artifacts.smithers.internal"
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024 // 512 MiB

const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DIGEST_RE = /^[0-9a-f]{64}$/

export interface CacheEntryRecord {
  readonly actionKey: string
  readonly casDigest: string
  readonly exitCode: number
  readonly durationMs: number
  readonly trustTier: "trusted:maintainer" | "trusted:sandbox"
  readonly actor: string
  readonly commitSha: string
  readonly recordedAt: string
}

export interface ArtifactMetadata {
  readonly name: string
  readonly namespace: string
  readonly key: string
  readonly sha256: string
  readonly bytes: number
  readonly contentType: string
  readonly visibility: "public" | "private"
  readonly trustTier: TrustTier
  readonly trusted: boolean
  readonly actor: string
  readonly commitSha: string
  readonly createdAt: string
}

export interface StoreStats {
  readonly endpoint: string
  readonly localRoot: string
  readonly casObjects: number
  readonly actionCacheEntries: number
  readonly trustedArtifacts: number
  readonly untrustedArtifacts: number
  readonly totalBytes: number
}

export class ObjectStoreError extends Error {
  readonly code:
    | "invalid_name"
    | "invalid_digest"
    | "too_large"
    | "cache_write_forbidden"
    | "integrity_mismatch"
    | "not_found"

  constructor(code: ObjectStoreError["code"], message: string) {
    super(message)
    this.name = "ObjectStoreError"
    this.code = code
  }
}

function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

export function validateArtifactName(name: string): void {
  if (!ARTIFACT_NAME_RE.test(name)) {
    throw new ObjectStoreError(
      "invalid_name",
      `Artifact name must match ${ARTIFACT_NAME_RE.source}: received "${name}"`
    )
  }
}

export function validateDigest(digest: string): void {
  if (!DIGEST_RE.test(digest)) {
    throw new ObjectStoreError("invalid_digest", `Expected 64-char lowercase hex SHA-256 digest`)
  }
}

/**
 * Shared Smithers Cloud Object Store client with local-first content-addressed
 * persistence and strict trust-tier write isolation.
 *
 * - Trusted executions (`trusted:maintainer` or `trusted:sandbox`) can read and
 *   write `/ac` (action cache), `/cas` (content-addressed blobs), and `trusted/`
 *   artifact pointers.
 * - Untrusted community executions (`untrusted:community`) receive full read-only
 *   cache hits from `/ac` and `/cas`, and write artifacts strictly to an isolated
 *   `untrusted/<actor>/<sha>/` namespace so cache poisoning is impossible.
 */
export class SharedObjectStore {
  readonly rootDir: string
  readonly endpoint: string
  private readonly casDir: string
  private readonly acDir: string
  private readonly artifactsIndexPath: string

  constructor(options: { readonly rootDir: string; readonly endpoint?: string }) {
    this.rootDir = resolve(options.rootDir)
    this.endpoint = (options.endpoint ?? DEFAULT_CLOUD_OBJECT_STORE_ENDPOINT).replace(/\/+$/, "")
    this.casDir = join(this.rootDir, "cas")
    this.acDir = join(this.rootDir, "ac")
    this.artifactsIndexPath = join(this.rootDir, "artifacts-index.json")
    mkdirSync(this.casDir, { recursive: true })
    mkdirSync(this.acDir, { recursive: true })
  }

  private readIndex(): ArtifactMetadata[] {
    if (!existsSync(this.artifactsIndexPath)) return []
    const raw = readFileSync(this.artifactsIndexPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ArtifactMetadata[]) : []
  }

  private writeIndex(entries: ReadonlyArray<ArtifactMetadata>): void {
    writeFileSync(this.artifactsIndexPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8")
  }

  putCas(data: Buffer | string, execution: VerifiedExecution): string {
    const policy = evaluateExecutionPolicy(execution)
    if (!policy.allowCacheWrite) {
      throw new ObjectStoreError(
        "cache_write_forbidden",
        `Untrusted execution (${execution.effectiveTier}) cannot write to shared CAS`
      )
    }
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data
    if (buf.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ObjectStoreError("too_large", `Object exceeds ${MAX_ARTIFACT_BYTES} bytes`)
    }
    const digest = sha256Bytes(buf)
    const target = join(this.casDir, digest)
    if (!existsSync(target)) {
      writeFileSync(target, buf)
    }
    return digest
  }

  getCas(digest: string): Buffer | null {
    validateDigest(digest)
    const target = join(this.casDir, digest)
    if (!existsSync(target)) return null
    const buf = readFileSync(target)
    const actual = sha256Bytes(buf)
    if (actual !== digest) {
      throw new ObjectStoreError(
        "integrity_mismatch",
        `CAS integrity check failed for ${digest}: actual ${actual}`
      )
    }
    return buf
  }

  putActionCache(
    actionKey: string,
    payload: Buffer | string,
    meta: { readonly exitCode: number; readonly durationMs: number },
    execution: VerifiedExecution
  ): CacheEntryRecord {
    validateDigest(actionKey)
    const policy = evaluateExecutionPolicy(execution)
    if (!policy.allowCacheWrite || execution.effectiveTier === "untrusted:community") {
      throw new ObjectStoreError(
        "cache_write_forbidden",
        `Untrusted execution (${execution.effectiveTier}) cannot write to shared action cache (/ac)`
      )
    }
    const casDigest = this.putCas(payload, execution)
    const record: CacheEntryRecord = {
      actionKey,
      casDigest,
      exitCode: meta.exitCode,
      durationMs: meta.durationMs,
      trustTier: execution.effectiveTier,
      actor: execution.actor,
      commitSha: execution.commitSha,
      recordedAt: new Date().toISOString()
    }
    writeFileSync(join(this.acDir, `${actionKey}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8")
    return record
  }

  /**
   * Action cache reads are open to everyone (including untrusted community runs)
   * so contributors benefit immediately from warm trusted cache entries.
   */
  getActionCache(actionKey: string): { readonly record: CacheEntryRecord; readonly payload: Buffer } | null {
    validateDigest(actionKey)
    const recordPath = join(this.acDir, `${actionKey}.json`)
    if (!existsSync(recordPath)) return null
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as CacheEntryRecord
    const payload = this.getCas(record.casDigest)
    if (!payload) return null
    return { record, payload }
  }

  /**
   * Stores an artifact in the shared object store.
   * Trusted runs write under `trusted/<sha>/<name>`.
   * Untrusted community runs are allowed and encouraged, but strictly isolated
   * under `untrusted/<actor>/<sha>/<name>` and never overwrite trusted pointers.
   */
  putArtifact(
    name: string,
    data: Buffer | string,
    options: {
      readonly contentType: string
      readonly visibility?: "public" | "private"
      readonly execution: VerifiedExecution
    }
  ): ArtifactMetadata {
    validateArtifactName(name)
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data
    if (buf.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ObjectStoreError("too_large", `Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
    }

    const policy = evaluateExecutionPolicy(options.execution)
    const digest = sha256Bytes(buf)
    const casTarget = join(this.casDir, digest)
    if (!existsSync(casTarget)) {
      writeFileSync(casTarget, buf)
    }

    const namespace = policy.artifactNamespace
    const key = `${namespace}/${name}`
    const metadata: ArtifactMetadata = {
      name,
      namespace,
      key,
      sha256: digest,
      bytes: buf.byteLength,
      contentType: options.contentType,
      visibility: options.visibility ?? "public",
      trustTier: options.execution.effectiveTier,
      trusted: options.execution.trusted,
      actor: options.execution.actor,
      commitSha: options.execution.commitSha,
      createdAt: new Date().toISOString()
    }

    const index = this.readIndex().filter((entry) => entry.key !== key)
    index.unshift(metadata)
    this.writeIndex(index)
    return metadata
  }

  listArtifacts(filter: { readonly trustedOnly?: boolean; readonly visibility?: "public" | "private" } = {}): ReadonlyArray<ArtifactMetadata> {
    return this.readIndex().filter((entry) => {
      if (filter.trustedOnly && !entry.trusted) return false
      if (filter.visibility && entry.visibility !== filter.visibility) return false
      return true
    })
  }

  getArtifact(key: string): { readonly metadata: ArtifactMetadata; readonly data: Buffer } | null {
    const entry = this.readIndex().find((item) => item.key === key)
    if (!entry) return null
    const data = this.getCas(entry.sha256)
    if (!data) return null
    return { metadata: entry, data }
  }

  stats(): StoreStats {
    const casFiles = readdirSync(this.casDir).filter((f) => DIGEST_RE.test(f))
    const acFiles = readdirSync(this.acDir).filter((f) => f.endsWith(".json"))
    const index = this.readIndex()
    let totalBytes = 0
    for (const file of casFiles) {
      totalBytes += statSync(join(this.casDir, file)).size
    }
    return {
      endpoint: this.endpoint,
      localRoot: this.rootDir,
      casObjects: casFiles.length,
      actionCacheEntries: acFiles.length,
      trustedArtifacts: index.filter((item) => item.trusted).length,
      untrustedArtifacts: index.filter((item) => !item.trusted).length,
      totalBytes
    }
  }
}
