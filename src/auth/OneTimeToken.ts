import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  PERSON_ONLY_ACTIONS,
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
  readonly issuedAt: string
  readonly expiresAt: string
  readonly singleUse: true
  readonly mcpEndpoint: string
}

export interface SessionLease {
  readonly leaseId: string
  readonly rawLeaseToken: string
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

function safeDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

export function intersectScopes(
  requested: ReadonlyArray<string>,
  trustTier: TrustTier
): { readonly granted: ReadonlyArray<TokenScope>; readonly stripped: ReadonlyArray<string> } {
  const validSet = new Set<string>(ALL_TOKEN_SCOPES)
  const personOnlySet = new Set<string>(PERSON_ONLY_ACTIONS)
  const granted: TokenScope[] = []
  const stripped: string[] = []
  const seen = new Set<string>()

  for (const raw of requested) {
    const scope = raw.trim()
    if (!scope || seen.has(scope)) continue
    seen.add(scope)

    // Person-only actions can NEVER be granted to any token.
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

  return { granted, stripped }
}

export class OneTimeTokenStore {
  private readonly tokensByDigest = new Map<string, StoredOneTimeToken>()
  private readonly tokensById = new Map<string, StoredOneTimeToken>()
  private readonly leasesByDigest = new Map<string, SessionLease>()
  private readonly now: () => Date
  private readonly baseUrl: string

  constructor(options: { readonly now?: () => Date; readonly baseUrl?: string } = {}) {
    this.now = options.now ?? (() => new Date())
    this.baseUrl = (options.baseUrl ?? "https://smithers.sh").replace(/\/+$/, "")
  }

  mint(request: MintRequest): MintedOneTimeToken {
    const repository = request.repository.trim().toLowerCase()
    if (!REPO_RE.test(repository)) {
      throw new Error(`Invalid repository name: ${request.repository}`)
    }
    const subject = request.subject.trim()
    if (subject.length < 2 || subject.length > 120 || /\s/.test(subject)) {
      throw new Error("Subject must be 2 to 120 non-whitespace characters")
    }
    if (request.commitSha && !SHA40_RE.test(request.commitSha)) {
      throw new Error("commitSha must be a 40-character hex SHA")
    }

    const ttlSeconds = Math.min(Math.max(Math.floor(request.ttlSeconds ?? 300), 30), 3600)
    const { granted, stripped } = intersectScopes(request.scopes, request.trustTier)
    if (granted.length === 0) {
      throw new Error("No permitted scopes remain after trust-tier intersection")
    }

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
      scopes: granted,
      commitSha: request.commitSha ? request.commitSha.toLowerCase() : null,
      sandboxId: request.sandboxId ? request.sandboxId.trim() : null,
      pkceChallenge: request.pkceChallenge ? request.pkceChallenge.trim() : null,
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
      scopes: granted,
      strippedScopes: stripped,
      commitSha: record.commitSha,
      sandboxId: record.sandboxId,
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
    if (!ONE_TIME_RE.test(options.rawToken)) {
      return { ok: false, code: "invalid_format", message: "One-time token must start with smo_ and 64 hex chars" }
    }

    const digest = sha256Hex(options.rawToken)
    let matched: StoredOneTimeToken | undefined
    for (const [storedDigest, record] of this.tokensByDigest.entries()) {
      if (safeDigestEqual(storedDigest, digest)) {
        matched = record
      }
    }

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
    if (now.getTime() > Date.parse(matched.expiresAt)) {
      return { ok: false, code: "expired", message: "One-time token has expired" }
    }

    if (matched.repository !== options.repository.trim().toLowerCase()) {
      return { ok: false, code: "repository_mismatch", message: "Token is scoped to a different repository" }
    }

    if (matched.pkceChallenge) {
      if (!options.pkceVerifier || computePkceS256Challenge(options.pkceVerifier) !== matched.pkceChallenge) {
        return { ok: false, code: "pkce_mismatch", message: "PKCE S256 verifier does not match challenge" }
      }
    }

    // Atomic single-use burn BEFORE emitting lease.
    matched.redeemedAt = now.toISOString()

    const leaseTtlSeconds = Math.min(Math.max(Math.floor(options.leaseTtlSeconds ?? 3600), 60), 28_800)
    const rawLeaseToken = `sms_${randomBytes(32).toString("hex")}`
    const leaseDigest = sha256Hex(rawLeaseToken)
    const lease: SessionLease = {
      leaseId: `lease_${randomBytes(8).toString("hex")}`,
      rawLeaseToken,
      leaseDigest,
      fromOneTimeTokenId: matched.id,
      repository: matched.repository,
      subject: matched.subject,
      trustTier: matched.trustTier,
      scopes: matched.scopes,
      commitSha: matched.commitSha,
      sandboxId: matched.sandboxId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseTtlSeconds * 1000).toISOString(),
      revokedAt: null
    }

    this.leasesByDigest.set(leaseDigest, lease)
    return { ok: true, lease }
  }

  verifyLease(rawLeaseToken: string, repository: string): SessionLease | null {
    if (!LEASE_RE.test(rawLeaseToken)) return null
    const digest = sha256Hex(rawLeaseToken)
    let matched: SessionLease | undefined
    for (const [storedDigest, lease] of this.leasesByDigest.entries()) {
      if (safeDigestEqual(storedDigest, digest)) {
        matched = lease
      }
    }
    if (!matched) return null
    if (matched.revokedAt !== null) return null
    if (this.now().getTime() > Date.parse(matched.expiresAt)) return null
    if (matched.repository !== repository.trim().toLowerCase()) return null
    return matched
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
    return Array.from(this.tokensById.values()).map(({ digest: _digest, ...rest }) => rest)
  }
}

/**
 * Formats a clean one-time bootstrap handoff for a sandbox or agent without
 * leaking tokens into persistent audit logs.
 */
export function formatBootstrapEnvelope(minted: MintedOneTimeToken): string {
  return [
    "=== Smithers Cloud One-Time Auth Bootstrap ===",
    `Token ID:     ${minted.id}`,
    `Repository:   ${minted.repository}`,
    `Subject:      ${minted.subject}`,
    `Trust Tier:   ${minted.trustTier}`,
    `Single Use:   yes (burns immediately on first redemption)`,
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
    `POST ${minted.mcpEndpoint.replace(/\/mcp$/, "/mcp/exchange")} with {"token":"<from-file>"}`,
    "==============================================="
  ].join("\n")
}

/**
 * Writes a raw token to a newly created mode-600 file, refusing symlinks,
 * existing targets, or group/world-writable parent directories.
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
  if (parentStat.isSymbolicLink()) {
    throw new Error("Refusing to write token into a symlinked directory")
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error("Refusing to write token into a group- or world-writable directory")
  }
  if (existsSync(absolute)) {
    throw new Error(`Refusing to overwrite existing token file: ${absolute}`)
  }

  const fd = openSync(absolute, "wx", 0o600)
  try {
    writeSync(fd, `${minted.rawToken}\n`, null, "utf8")
  } finally {
    closeSync(fd)
  }
  chmodSync(absolute, 0o600)

  const receiptPath = `${absolute}.json`
  const receipt = {
    id: minted.id,
    digest: minted.digest,
    repository: minted.repository,
    subject: minted.subject,
    trustTier: minted.trustTier,
    scopes: minted.scopes,
    commitSha: minted.commitSha,
    sandboxId: minted.sandboxId,
    issuedAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
    singleUse: true,
    mcpEndpoint: minted.mcpEndpoint
  }

  const rfd = openSync(receiptPath, "wx", 0o600)
  try {
    writeSync(rfd, `${JSON.stringify(receipt, null, 2)}\n`, null, "utf8")
  } finally {
    closeSync(rfd)
  }
  chmodSync(receiptPath, 0o600)

  return { tokenPath: absolute, receiptPath }
}
