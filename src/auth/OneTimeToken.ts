import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync
} from "node:fs"
import { dirname, resolve } from "node:path"
import {
  PERSON_ONLY_ACTIONS,
  VALID_TRUST_TIERS,
  type TrustTier,
  sanitizeActor
} from "../trust/ExecutionTrust.ts"

export type TokenScope =
  | "mcp:read"
  | "mcp:write"
  | "cache:read"
  | "cache:write"
  | "artifact:read"
  | "artifact:write:trusted"
  | "artifact:write:untrusted"
  | "todo:draft"
  | "issue:create"
  | "issue:comment"
  | "pr:draft"
  | "changeset:propose"
  | "audit:run"
  | "gate:satisfy"

export const ALL_TOKEN_SCOPES: ReadonlyArray<TokenScope> = [
  "mcp:read",
  "mcp:write",
  "cache:read",
  "cache:write",
  "artifact:read",
  "artifact:write:trusted",
  "artifact:write:untrusted",
  "todo:draft",
  "issue:create",
  "issue:comment",
  "pr:draft",
  "changeset:propose",
  "audit:run",
  "gate:satisfy"
]

const TRUSTED_TIERS = new Set<TrustTier>(["trusted:maintainer", "trusted:sandbox"])

const UNTRUSTED_ALLOWED_SCOPES = new Set<TokenScope>([
  "mcp:read",
  "cache:read",
  "artifact:read",
  "artifact:write:untrusted",
  "todo:draft",
  "issue:create",
  "issue:comment",
  "pr:draft",
  "changeset:propose",
  "audit:run"
])

export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

export interface MintRequest {
  readonly repository: string
  readonly subject: string
  readonly mintedBy: string
  readonly trustTier: TrustTier
  readonly scopes: ReadonlyArray<string>
  readonly commitSha?: string | null
  readonly sandboxId?: string | null
  readonly pkceChallenge?: string | null
  readonly ttlSeconds?: number
}

export interface StoredOneTimeToken {
  readonly id: string
  readonly digest: string
  readonly repository: string
  readonly subject: string
  readonly mintedBy: string
  readonly trustTier: TrustTier
  readonly scopes: ReadonlyArray<TokenScope>
  readonly commitSha: string | null
  readonly sandboxId: string | null
  readonly pkceChallenge: string | null
  readonly issuedAt: string
  readonly expiresAt: string
  readonly singleUse: true
  redeemedAt: string | null
  revokedAt: string | null
}

export interface MintedOneTimeToken {
  readonly id: string
  readonly rawToken: string
  readonly digest: string
  readonly repository: string
  readonly subject: string
  readonly trustTier: TrustTier
  readonly scopes: ReadonlyArray<TokenScope>
  readonly strippedScopes: ReadonlyArray<string>
  readonly commitSha: string | null
  readonly sandboxId: string | null
  readonly pkceRequired: boolean
  readonly issuedAt: string
  readonly expiresAt: string
  readonly singleUse: true
  readonly mcpEndpoint: string
}

export interface StoredSessionLease {
  readonly leaseId: string
  readonly leaseDigest: string
  readonly fromOneTimeTokenId: string
  readonly repository: string
  readonly subject: string
  readonly trustTier: TrustTier
  readonly scopes: ReadonlyArray<TokenScope>
  readonly commitSha: string | null
  readonly sandboxId: string | null
  readonly issuedAt: string
  readonly expiresAt: string
  revokedAt: string | null
}

export interface SessionLease extends StoredSessionLease {
  readonly rawLeaseToken: string
}

export type RedeemResult =
  | { readonly ok: true; readonly lease: SessionLease }
  | {
      readonly ok: false
      readonly code:
        | "invalid_format"
        | "not_found"
        | "expired"
        | "revoked"
        | "already_redeemed"
        | "repository_mismatch"
        | "pkce_mismatch"
      readonly message: string
    }

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA40_RE = /^[0-9a-f]{40}$/i
const ONE_TIME_RE = /^smo_[0-9a-f]{64}$/
const LEASE_RE = /^sms_[0-9a-f]{64}$/

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function computePkceS256Challenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export function isValidPkceChallenge(challenge: string): boolean {
  return PKCE_CHALLENGE_RE.test(challenge)
}

export function isValidPkceVerifier(verifier: string): boolean {
  return PKCE_VERIFIER_RE.test(verifier)
}

function safeDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

export function intersectScopes(
  requested: ReadonlyArray<string>,
  trustTier: TrustTier
): { readonly granted: ReadonlyArray<TokenScope>; readonly stripped: ReadonlyArray<string> } {
  if (!VALID_TRUST_TIERS.has(String(trustTier))) {
    throw new Error(`Unsupported trust tier for scope intersection: ${String(trustTier)}`)
  }
  const validSet = new Set<string>(ALL_TOKEN_SCOPES)
  const personOnlySet = new Set<string>(PERSON_ONLY_ACTIONS)
  const granted: TokenScope[] = []
  const stripped: string[] = []
  const seen = new Set<string>()

  for (const raw of requested) {
    if (typeof raw !== "string") continue
    const scope = raw.trim()
    if (!scope || seen.has(scope)) continue
    seen.add(scope)

    // Person-only actions and unknown scopes can NEVER be granted to any token.
    if (personOnlySet.has(scope) || !validSet.has(scope)) {
      stripped.push(scope)
      continue
    }

    const typed = scope as TokenScope
    if (!TRUSTED_TIERS.has(trustTier) && !UNTRUSTED_ALLOWED_SCOPES.has(typed)) {
      stripped.push(scope)
      continue
    }

    granted.push(typed)
  }

  return { granted: Object.freeze([...granted]), stripped: Object.freeze([...stripped]) }
}

export class OneTimeTokenStore {
  private readonly tokensByDigest = new Map<string, StoredOneTimeToken>()
  private readonly tokensById = new Map<string, StoredOneTimeToken>()
  private readonly leasesByDigest = new Map<string, StoredSessionLease>()
  private readonly now: () => Date
  private readonly baseUrl: string

  constructor(options: { readonly now?: () => Date; readonly baseUrl?: string } = {}) {
    this.now = options.now ?? (() => new Date())
    this.baseUrl = (options.baseUrl ?? "https://smithers.sh").replace(/\/+$/, "")
  }

  pruneExpired(): number {
    const nowMs = this.now().getTime()
    let removed = 0
    for (const [digest, lease] of this.leasesByDigest.entries()) {
      if (lease.revokedAt !== null || nowMs >= Date.parse(lease.expiresAt)) {
        this.leasesByDigest.delete(digest)
        removed += 1
      }
    }
    for (const [digest, token] of this.tokensByDigest.entries()) {
      const expiredLongAgo = nowMs >= Date.parse(token.expiresAt) + 3_600_000
      if (expiredLongAgo) {
        this.tokensByDigest.delete(digest)
        this.tokensById.delete(token.id)
        removed += 1
      }
    }
    return removed
  }

  mint(request: MintRequest): MintedOneTimeToken {
    if (!VALID_TRUST_TIERS.has(String(request.trustTier))) {
      throw new Error(`Invalid trust tier: ${String(request.trustTier)}`)
    }
    const repository = String(request.repository ?? "").trim().toLowerCase()
    if (!REPO_RE.test(repository)) {
      throw new Error(`Invalid repository name: ${request.repository}`)
    }
    const subject = String(request.subject ?? "").trim()
    if (subject.length < 2 || subject.length > 120 || /\s/.test(subject)) {
      throw new Error("Subject must be 2 to 120 non-whitespace characters")
    }
    if (request.commitSha !== undefined && request.commitSha !== null && !SHA40_RE.test(request.commitSha)) {
      throw new Error("commitSha must be a 40-character hex SHA")
    }

    let pkceChallenge: string | null = null
    if (request.pkceChallenge !== undefined && request.pkceChallenge !== null) {
      if (typeof request.pkceChallenge !== "string") {
        throw new Error("pkceChallenge must be a valid 43-character base64url S256 digest")
      }
      const trimmed = request.pkceChallenge.trim()
      if (!isValidPkceChallenge(trimmed)) {
        throw new Error("pkceChallenge must be a 43-character base64url S256 digest")
      }
      pkceChallenge = trimmed
    }

    const rawTtl = request.ttlSeconds ?? 300
    if (typeof rawTtl !== "number" || !Number.isFinite(rawTtl)) {
      throw new Error("ttlSeconds must be a finite number")
    }
    const ttlSeconds = Math.min(Math.max(Math.floor(rawTtl), 30), 3600)
    const { granted, stripped } = intersectScopes(request.scopes, request.trustTier)
    if (granted.length === 0) {
      throw new Error("No permitted scopes remain after trust-tier intersection")
    }

    this.pruneExpired()

    const id = `ott_${randomBytes(8).toString("hex")}`
    const rawToken = `smo_${randomBytes(32).toString("hex")}`
    const digest = sha256Hex(rawToken)
    const issuedAt = this.now()
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000)

    const record: StoredOneTimeToken = {
      id,
      digest,
      repository,
      subject,
      mintedBy: sanitizeActor(request.mintedBy),
      trustTier: request.trustTier,
      scopes: Object.freeze([...granted]),
      commitSha: request.commitSha ? request.commitSha.toLowerCase() : null,
      sandboxId: request.sandboxId ? request.sandboxId.trim() : null,
      pkceChallenge,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      singleUse: true,
      redeemedAt: null,
      revokedAt: null
    }

    this.tokensByDigest.set(digest, record)
    this.tokensById.set(id, record)

    return {
      id,
      rawToken,
      digest,
      repository,
      subject,
      trustTier: request.trustTier,
      scopes: Object.freeze([...granted]),
      strippedScopes: Object.freeze([...stripped]),
      commitSha: record.commitSha,
      sandboxId: record.sandboxId,
      pkceRequired: pkceChallenge !== null,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      singleUse: true,
      mcpEndpoint: `${this.baseUrl}/${repository}/mcp`
    }
  }

  redeem(options: {
    readonly rawToken: string
    readonly repository: string
    readonly pkceVerifier?: string | null
    readonly leaseTtlSeconds?: number
  }): RedeemResult {
    if (typeof options.rawToken !== "string" || !ONE_TIME_RE.test(options.rawToken)) {
      return { ok: false, code: "invalid_format", message: "One-time token must start with smo_ and 64 hex chars" }
    }

    const digest = sha256Hex(options.rawToken)
    const candidate = this.tokensByDigest.get(digest)
    const matched = candidate && safeDigestEqual(candidate.digest, digest) ? candidate : undefined

    if (!matched) {
      return { ok: false, code: "not_found", message: "Unknown one-time authentication token" }
    }

    if (matched.revokedAt !== null) {
      return { ok: false, code: "revoked", message: "One-time token was revoked" }
    }

    if (matched.redeemedAt !== null) {
      return { ok: false, code: "already_redeemed", message: "One-time token has already been redeemed" }
    }

    const now = this.now()
    if (now.getTime() >= Date.parse(matched.expiresAt)) {
      return { ok: false, code: "expired", message: "One-time token has expired" }
    }

    if (matched.repository !== String(options.repository ?? "").trim().toLowerCase()) {
      return { ok: false, code: "repository_mismatch", message: "Token is scoped to a different repository" }
    }

    if (matched.pkceChallenge) {
      const verifier = typeof options.pkceVerifier === "string" ? options.pkceVerifier : ""
      if (!isValidPkceVerifier(verifier)) {
        return { ok: false, code: "pkce_mismatch", message: "PKCE S256 verifier is missing or violates RFC 7636 format" }
      }
      const computed = computePkceS256Challenge(verifier)
      if (!safeDigestEqual(computed, matched.pkceChallenge)) {
        return { ok: false, code: "pkce_mismatch", message: "PKCE S256 verifier does not match challenge" }
      }
    }

    const rawLeaseTtl = options.leaseTtlSeconds ?? 3600
    const leaseTtlSeconds =
      typeof rawLeaseTtl === "number" && Number.isFinite(rawLeaseTtl)
        ? Math.min(Math.max(Math.floor(rawLeaseTtl), 60), 28_800)
        : 3600

    // Atomic single-use burn BEFORE emitting lease.
    matched.redeemedAt = now.toISOString()

    const rawLeaseToken = `sms_${randomBytes(32).toString("hex")}`
    const leaseDigest = sha256Hex(rawLeaseToken)
    const storedLease: StoredSessionLease = {
      leaseId: `lease_${randomBytes(8).toString("hex")}`,
      leaseDigest,
      fromOneTimeTokenId: matched.id,
      repository: matched.repository,
      subject: matched.subject,
      trustTier: matched.trustTier,
      scopes: Object.freeze([...matched.scopes]),
      commitSha: matched.commitSha,
      sandboxId: matched.sandboxId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseTtlSeconds * 1000).toISOString(),
      revokedAt: null
    }

    // Store ONLY the digest-keyed metadata; never retain rawLeaseToken in memory.
    this.leasesByDigest.set(leaseDigest, storedLease)
    return {
      ok: true,
      lease: {
        ...storedLease,
        scopes: Object.freeze([...storedLease.scopes]),
        rawLeaseToken
      }
    }
  }

  verifyLease(rawLeaseToken: string, repository: string): StoredSessionLease | null {
    if (typeof rawLeaseToken !== "string" || !LEASE_RE.test(rawLeaseToken)) return null
    const digest = sha256Hex(rawLeaseToken)
    const candidate = this.leasesByDigest.get(digest)
    if (!candidate || !safeDigestEqual(candidate.leaseDigest, digest)) return null
    if (candidate.revokedAt !== null) return null
    if (this.now().getTime() >= Date.parse(candidate.expiresAt)) return null
    if (candidate.repository !== String(repository ?? "").trim().toLowerCase()) return null
    return { ...candidate, scopes: Object.freeze([...candidate.scopes]) }
  }

  revokeToken(id: string): boolean {
    const record = this.tokensById.get(id)
    if (!record) return false
    record.revokedAt = this.now().toISOString()
    return true
  }

  revokeLease(leaseId: string): boolean {
    for (const lease of this.leasesByDigest.values()) {
      if (lease.leaseId === leaseId) {
        lease.revokedAt = this.now().toISOString()
        return true
      }
    }
    return false
  }

  listAuditSummaries(): ReadonlyArray<Omit<StoredOneTimeToken, "digest">> {
    return Array.from(this.tokensById.values()).map(({ digest: _digest, ...rest }) => ({
      ...rest,
      scopes: Object.freeze([...rest.scopes])
    }))
  }
}

/**
 * Formats a clean one-time bootstrap handoff for a sandbox or agent without
 * leaking tokens into persistent audit logs.
 */
export function formatBootstrapEnvelope(minted: MintedOneTimeToken): string {
  const exchangeBody = minted.pkceRequired
    ? `{"token":"<from-file>","pkceVerifier":"<your-rfc7636-verifier>"}`
    : `{"token":"<from-file>"}`
  return [
    "=== Smithers Cloud One-Time Auth Bootstrap ===",
    `Token ID:     ${minted.id}`,
    `Repository:   ${minted.repository}`,
    `Subject:      ${minted.subject}`,
    `Trust Tier:   ${minted.trustTier}`,
    `Single Use:   yes (burns immediately on first redemption)`,
    `PKCE S256:    ${minted.pkceRequired ? "required" : "optional"}`,
    `Expires At:   ${minted.expiresAt}`,
    `MCP Endpoint: ${minted.mcpEndpoint}`,
    `Scopes:       ${minted.scopes.join(", ")}`,
    minted.strippedScopes.length > 0
      ? `Stripped:     ${minted.strippedScopes.join(", ")} (blocked by trust or person-only policy)`
      : `Stripped:     none`,
    "",
    "One-Time Token (pass via mode-600 file or stdin, never commit or log):",
    minted.rawToken,
    "",
    "Redeem over Streamable HTTP MCP:",
    `POST ${minted.mcpEndpoint.replace(/\/mcp$/, "/mcp/exchange")} with ${exchangeBody}`,
    "==============================================="
  ].join("\n")
}

/**
 * Writes a raw token to a newly created mode-600 file, refusing symlinks,
 * existing targets, or group/world-writable parent directories, enforcing
 * permissions via fchmodSync on the open descriptor and rolling back if
 * receipt publication fails.
 */
export function writeTokenFile(filePath: string, minted: MintedOneTimeToken): {
  readonly tokenPath: string
  readonly receiptPath: string
} {
  const absolute = resolve(filePath)
  const parent = dirname(absolute)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
  const parentStat = lstatSync(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Refusing to write token into a symlinked or non-directory parent")
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error("Refusing to write token into a group- or world-writable directory")
  }
  if (existsSync(absolute)) {
    throw new Error(`Refusing to overwrite existing token file: ${absolute}`)
  }

  const receiptPath = `${absolute}.json`
  if (existsSync(receiptPath)) {
    throw new Error(`Refusing to overwrite existing token receipt file: ${receiptPath}`)
  }

  const fd = openSync(absolute, "wx", 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, `${minted.rawToken}\n`, null, "utf8")
  } catch (err) {
    closeSync(fd)
    try {
      unlinkSync(absolute)
    } catch {
      // ignore cleanup error
    }
    throw err
  }
  closeSync(fd)

  const receipt = {
    id: minted.id,
    digest: minted.digest,
    repository: minted.repository,
    subject: minted.subject,
    trustTier: minted.trustTier,
    scopes: [...minted.scopes],
    commitSha: minted.commitSha,
    sandboxId: minted.sandboxId,
    pkceRequired: minted.pkceRequired,
    issuedAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
    singleUse: true,
    mcpEndpoint: minted.mcpEndpoint
  }

  try {
    const rfd = openSync(receiptPath, "wx", 0o600)
    try {
      fchmodSync(rfd, 0o600)
      writeSync(rfd, `${JSON.stringify(receipt, null, 2)}\n`, null, "utf8")
    } finally {
      closeSync(rfd)
    }
  } catch (err) {
    try {
      unlinkSync(absolute)
    } catch {
      // ignore cleanup error
    }
    throw err
  }

  return { tokenPath: absolute, receiptPath }
}
