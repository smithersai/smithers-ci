import { createHash, randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  type TrustTier,
  type VerifiedExecution,
  evaluateExecutionPolicy
} from "../trust/ExecutionTrust.ts"

export const DEFAULT_CLOUD_OBJECT_STORE_ENDPOINT = "https://build.smithers.sh"
export const DEFAULT_ARTIFACTS_INTERNAL_ENDPOINT = "http://artifacts.smithers.internal"
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024 // 512 MiB
export const DEFAULT_UNTRUSTED_MAX_OBJECTS_PER_ACTOR = 100
export const DEFAULT_UNTRUSTED_MAX_BYTES_PER_ACTOR = 10 * 1024 * 1024 // 10 MiB

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
  readonly untrustedCasObjects: number
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
    | "quota_exceeded"
    | "cache_write_forbidden"
    | "integrity_mismatch"
    | "forbidden"
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

function atomicWriteFile(targetPath: string, data: Buffer | string): void {
  const parent = dirname(targetPath)
  mkdirSync(parent, { recursive: true })
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  try {
    writeFileSync(tmpPath, data)
    renameSync(tmpPath, targetPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup error
    }
    throw err
  }
}

export function validateArtifactName(name: string): void {
  if (typeof name !== "string" || !ARTIFACT_NAME_RE.test(name)) {
    throw new ObjectStoreError(
      "invalid_name",
      `Artifact name must match ${ARTIFACT_NAME_RE.source}: received "${String(name)}"`
    )
  }
}

export function validateDigest(digest: string): void {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
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
 *   `untrusted-cas/` blob directory and `untrusted/<actor>/<sha>/` namespace with
 *   per-actor quotas so cache poisoning and shared-CAS exhaustion are impossible.
 */
export class SharedObjectStore {
  readonly rootDir: string
  readonly endpoint: string
  private readonly casDir: string
  private readonly untrustedCasDir: string
  private readonly acDir: string
  private readonly artifactsIndexPath: string
  private readonly maxUntrustedObjectsPerActor: number
  private readonly maxUntrustedBytesPerActor: number

  constructor(options: {
    readonly rootDir: string
    readonly endpoint?: string
    readonly maxUntrustedObjectsPerActor?: number
    readonly maxUntrustedBytesPerActor?: number
  }) {
    this.rootDir = resolve(options.rootDir)
    this.endpoint = (options.endpoint ?? DEFAULT_CLOUD_OBJECT_STORE_ENDPOINT).replace(/\/+$/, "")
    this.casDir = join(this.rootDir, "cas")
    this.untrustedCasDir = join(this.rootDir, "untrusted-cas")
    this.acDir = join(this.rootDir, "ac")
    this.artifactsIndexPath = join(this.rootDir, "artifacts-index.json")
    this.maxUntrustedObjectsPerActor =
      options.maxUntrustedObjectsPerActor ?? DEFAULT_UNTRUSTED_MAX_OBJECTS_PER_ACTOR
    this.maxUntrustedBytesPerActor =
      options.maxUntrustedBytesPerActor ?? DEFAULT_UNTRUSTED_MAX_BYTES_PER_ACTOR
    mkdirSync(this.casDir, { recursive: true })
    mkdirSync(this.untrustedCasDir, { recursive: true })
    mkdirSync(this.acDir, { recursive: true })
  }

  private readIndex(): ArtifactMetadata[] {
    if (!existsSync(this.artifactsIndexPath)) return []
    const raw = readFileSync(this.artifactsIndexPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ArtifactMetadata[]) : []
  }

  private writeIndex(entries: ReadonlyArray<ArtifactMetadata>): void {
    atomicWriteFile(this.artifactsIndexPath, `${JSON.stringify(entries, null, 2)}\n`)
  }

  private writeBlobToDir(dir: string, buf: Buffer): string {
    const digest = sha256Bytes(buf)
    const target = join(dir, digest)
    if (existsSync(target)) {
      const existing = readFileSync(target)
      if (sha256Bytes(existing) === digest) {
        return digest
      }
      // Existing blob is corrupt or partial: atomically repair it.
    }
    atomicWriteFile(target, buf)
    return digest
  }

  private readBlobFromDir(dir: string, digest: string): Buffer | null {
    validateDigest(digest)
    const target = join(dir, digest)
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
    return this.writeBlobToDir(this.casDir, buf)
  }

  getCas(digest: string): Buffer | null {
    return this.readBlobFromDir(this.casDir, digest)
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
    atomicWriteFile(join(this.acDir, `${actionKey}.json`), `${JSON.stringify(record, null, 2)}\n`)
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
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(recordPath, "utf8"))
    } catch {
      throw new ObjectStoreError("integrity_mismatch", `Corrupt action cache record for ${actionKey}`)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ObjectStoreError("integrity_mismatch", `Invalid action cache record shape for ${actionKey}`)
    }
    const rec = parsed as Record<string, unknown>
    if (
      rec.actionKey !== actionKey ||
      typeof rec.casDigest !== "string" ||
      !DIGEST_RE.test(rec.casDigest) ||
      typeof rec.exitCode !== "number" ||
      !Number.isFinite(rec.exitCode) ||
      typeof rec.durationMs !== "number" ||
      !Number.isFinite(rec.durationMs) ||
      (rec.trustTier !== "trusted:maintainer" && rec.trustTier !== "trusted:sandbox")
    ) {
      throw new ObjectStoreError("integrity_mismatch", `Action cache record failed schema/key binding for ${actionKey}`)
    }
    const record = parsed as CacheEntryRecord
    const payload = this.getCas(record.casDigest)
    if (!payload) return null
    return { record, payload }
  }

  /**
   * Stores an artifact in the shared object store.
   * Trusted runs write blobs into `cas/` and pointers under `trusted/<sha>/<name>`.
   * Untrusted community runs are allowed and encouraged, but write blobs strictly into
   * quota-bounded `untrusted-cas/` and pointers under `untrusted/<actor>/<sha>/<name>`.
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
    const isTrustedWrite = policy.allowTrustedArtifactWrite && options.execution.trusted
    const index = this.readIndex()
    const namespace = policy.artifactNamespace
    const key = `${namespace}/${name}`

    if (!isTrustedWrite) {
      const actorEntries = index.filter(
        (entry) => !entry.trusted && entry.actor === options.execution.actor && entry.key !== key
      )
      const actorBytes = actorEntries.reduce((sum, entry) => sum + entry.bytes, 0)
      if (actorEntries.length >= this.maxUntrustedObjectsPerActor) {
        throw new ObjectStoreError(
          "quota_exceeded",
          `Untrusted actor ${options.execution.actor} exceeded object quota (${this.maxUntrustedObjectsPerActor})`
        )
      }
      if (actorBytes + buf.byteLength > this.maxUntrustedBytesPerActor) {
        throw new ObjectStoreError(
          "quota_exceeded",
          `Untrusted actor ${options.execution.actor} exceeded byte quota (${this.maxUntrustedBytesPerActor} bytes)`
        )
      }
    }

    const blobDir = isTrustedWrite ? this.casDir : this.untrustedCasDir
    const digest = this.writeBlobToDir(blobDir, buf)

    const metadata: ArtifactMetadata = {
      name,
      namespace,
      key,
      sha256: digest,
      bytes: buf.byteLength,
      contentType: options.contentType,
      visibility: options.visibility ?? "public",
      trustTier: isTrustedWrite ? options.execution.effectiveTier : "untrusted:community",
      trusted: isTrustedWrite,
      actor: options.execution.actor,
      commitSha: options.execution.commitSha,
      createdAt: new Date().toISOString()
    }

    const nextIndex = index.filter((entry) => entry.key !== key)
    nextIndex.unshift(metadata)
    this.writeIndex(nextIndex)
    return metadata
  }

  listArtifacts(
    filter: {
      readonly trustedOnly?: boolean
      readonly visibility?: "public" | "private"
      readonly includePrivate?: boolean
    } = {}
  ): ReadonlyArray<ArtifactMetadata> {
    return this.readIndex().filter((entry) => {
      if (filter.trustedOnly && !entry.trusted) return false
      if (filter.visibility) {
        return entry.visibility === filter.visibility
      }
      if (!filter.includePrivate && entry.visibility !== "public") {
        return false
      }
      return true
    })
  }

  getArtifact(
    key: string,
    options: { readonly allowPrivate?: boolean } = {}
  ): { readonly metadata: ArtifactMetadata; readonly data: Buffer } | null {
    const entry = this.readIndex().find((item) => item.key === key)
    if (!entry) return null
    if (entry.visibility === "private" && !options.allowPrivate) {
      throw new ObjectStoreError("forbidden", `Private artifact ${key} requires authorized read access`)
    }
    const blobDir = entry.trusted ? this.casDir : this.untrustedCasDir
    const data = this.readBlobFromDir(blobDir, entry.sha256)
    if (!data) return null
    return { metadata: entry, data }
  }

  stats(): StoreStats {
    const casFiles = readdirSync(this.casDir).filter((f) => DIGEST_RE.test(f))
    const untrustedCasFiles = readdirSync(this.untrustedCasDir).filter((f) => DIGEST_RE.test(f))
    const acFiles = readdirSync(this.acDir).filter((f) => f.endsWith(".json"))
    const index = this.readIndex()
    let totalBytes = 0
    for (const file of casFiles) {
      totalBytes += statSync(join(this.casDir, file)).size
    }
    for (const file of untrustedCasFiles) {
      totalBytes += statSync(join(this.untrustedCasDir, file)).size
    }
    return {
      endpoint: this.endpoint,
      localRoot: this.rootDir,
      casObjects: casFiles.length,
      untrustedCasObjects: untrustedCasFiles.length,
      actionCacheEntries: acFiles.length,
      trustedArtifacts: index.filter((item) => item.trusted).length,
      untrustedArtifacts: index.filter((item) => !item.trusted).length,
      totalBytes
    }
  }
}
