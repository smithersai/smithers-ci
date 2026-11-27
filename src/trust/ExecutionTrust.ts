import { createHmac, timingSafeEqual } from "node:crypto"

export type TrustTier =
  | "trusted:maintainer"
  | "trusted:sandbox"
  | "untrusted:community"

export type CallerKind = "person" | "agent" | "sandbox"

export const VALID_TRUST_TIERS: ReadonlySet<string> = new Set<TrustTier>([
  "trusted:maintainer",
  "trusted:sandbox",
  "untrusted:community"
])

export const VALID_CALLER_KINDS: ReadonlySet<string> = new Set<CallerKind>([
  "person",
  "agent",
  "sandbox"
])

export const PERSON_ONLY_ACTIONS = [
  "pr/merge",
  "todo/commit",
  "todo/drop",
  "release/publish",
  "secrets/write",
  "policy/update",
  "maintainer/add",
  "triage/override"
] as const

export type PersonOnlyAction = (typeof PERSON_ONLY_ACTIONS)[number]

const KNOWN_NON_PERSON_ACTIONS: ReadonlySet<string> = new Set([
  "cache/read",
  "cache/write",
  "artifact/read",
  "artifact/publish-trusted",
  "artifact/publish-untrusted",
  "gate/satisfy",
  "todo/draft",
  "issue/create",
  "issue/comment",
  "pr/draft",
  "changeset/propose",
  "audit/run",
  "mcp/read",
  "mcp/write"
])

export const DEFAULT_MAINTAINERS = ["roninjin10"] as const

export const CONTROLLED_SANDBOX_PREFIXES = [
  "cfbox-",
  "gate-",
  "smithers-sandbox-",
  "nyc-01-",
  "nyc-02-"
] as const

export interface ExecutionClaim {
  readonly tier: TrustTier
  readonly callerKind: CallerKind
  readonly actor: string
  readonly repository: string
  readonly commitSha: string
  readonly sandboxId?: string | null
  readonly issuedAt: string
  readonly expiresAt: string
  readonly attestation?: string | null
}

export interface TrustPolicyConfig {
  readonly maintainers: ReadonlyArray<string>
  readonly controlledSandboxPrefixes: ReadonlyArray<string>
  readonly signingSecret?: string | null
  readonly now?: () => Date
}

export interface VerifiedExecution {
  readonly effectiveTier: TrustTier
  readonly claimedTier: TrustTier
  readonly callerKind: CallerKind
  readonly actor: string
  readonly repository: string
  readonly commitSha: string
  readonly sandboxId: string | null
  readonly trusted: boolean
  readonly downgraded: boolean
  readonly downgradeReason: string | null
  readonly verifiedAt: string
  readonly expiresAt?: string
}

export interface ExecutionCapabilities {
  readonly allowExecution: true
  readonly allowCacheRead: true
  readonly allowCacheWrite: boolean
  readonly allowTrustedArtifactWrite: boolean
  readonly allowUntrustedArtifactWrite: true
  readonly canSatisfyGates: boolean
  readonly artifactNamespace: string
  readonly provenanceBadge: "TRUSTED MAINTAINER" | "TRUSTED SANDBOX" | "UNTRUSTED COMMUNITY"
}

export interface GateCheckResult {
  readonly gate: string
  readonly passed: boolean
  readonly satisfied: boolean
  readonly status: "passed" | "failed" | "untrusted_preview"
  readonly trustTier: TrustTier
  readonly reason: string
}

export interface GateReceipt {
  readonly repository: string
  readonly commitSha: string
  readonly gate: string
  readonly score: number
  readonly passed: boolean
  readonly satisfied: boolean
  readonly trustTier: TrustTier
  readonly actor: string
  readonly verifiedAt: string
}

export interface ActionAuthorization {
  readonly allowed: boolean
  readonly code:
    | "ok"
    | "person_only"
    | "untrusted_write_forbidden"
    | "maintainer_required"
    | "unknown_action"
  readonly reason: string
}

const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ACTOR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/

export function sanitizeActor(actor: string): string {
  const cleaned = String(actor ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const collapsed = cleaned.replace(/-+/g, "-").replace(/^-|-$/g, "")
  return collapsed.length > 0 ? collapsed.slice(0, 63) : "anonymous"
}

export function canonicalAttestationPayload(claim: Omit<ExecutionClaim, "attestation">): string {
  return JSON.stringify({
    tier: claim.tier,
    callerKind: claim.callerKind,
    actor: String(claim.actor ?? "").trim().toLowerCase(),
    repository: String(claim.repository ?? "").trim().toLowerCase(),
    commitSha: String(claim.commitSha ?? "").trim().toLowerCase(),
    sandboxId: claim.sandboxId ?? null,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt
  })
}

export function signExecutionClaim(
  claim: Omit<ExecutionClaim, "attestation">,
  signingSecret: string
): ExecutionClaim {
  if (!signingSecret || signingSecret.length < 16) {
    throw new Error("Execution signing secret must be at least 16 characters")
  }
  if (!VALID_TRUST_TIERS.has(String(claim.tier))) {
    throw new Error(`Unsupported trust tier: ${String(claim.tier)}`)
  }
  if (!VALID_CALLER_KINDS.has(String(claim.callerKind))) {
    throw new Error(`Unsupported caller kind: ${String(claim.callerKind)}`)
  }
  const mac = createHmac("sha256", signingSecret)
    .update(canonicalAttestationPayload(claim))
    .digest("hex")
  return { ...claim, attestation: mac }
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function verifyExecutionTrust(
  claim: ExecutionClaim,
  config: Partial<TrustPolicyConfig> = {}
): VerifiedExecution {
  const now = (config.now ?? (() => new Date()))()
  const maintainers = new Set(
    (config.maintainers ?? DEFAULT_MAINTAINERS).map((m) => m.trim().toLowerCase())
  )
  const sandboxPrefixes = config.controlledSandboxPrefixes ?? CONTROLLED_SANDBOX_PREFIXES
  const rawTier = typeof claim?.tier === "string" ? claim.tier : ""
  const rawCallerKind = typeof claim?.callerKind === "string" ? claim.callerKind : ""
  const safeCallerKind: CallerKind = VALID_CALLER_KINDS.has(rawCallerKind)
    ? (rawCallerKind as CallerKind)
    : "agent"
  const safeClaimedTier: TrustTier = VALID_TRUST_TIERS.has(rawTier)
    ? (rawTier as TrustTier)
    : "untrusted:community"
  const actor = sanitizeActor(typeof claim?.actor === "string" ? claim.actor : "")
  const repository = typeof claim?.repository === "string" ? claim.repository.trim().toLowerCase() : ""
  const commitSha = typeof claim?.commitSha === "string" ? claim.commitSha.trim().toLowerCase() : ""
  const sandboxId = typeof claim?.sandboxId === "string" && claim.sandboxId.trim().length > 0
    ? claim.sandboxId.trim()
    : null

  const downgrade = (reason: string, forceDowngraded = false): VerifiedExecution => ({
    effectiveTier: "untrusted:community",
    claimedTier: safeClaimedTier,
    callerKind: safeCallerKind,
    actor,
    repository,
    commitSha,
    sandboxId,
    trusted: false,
    downgraded: forceDowngraded || rawTier !== "untrusted:community",
    downgradeReason: !forceDowngraded && rawTier === "untrusted:community" ? null : reason,
    verifiedAt: now.toISOString()
  })

  if (!VALID_TRUST_TIERS.has(rawTier)) {
    return downgrade(`unsupported trust tier: ${rawTier || "empty"}`, true)
  }

  if (!VALID_CALLER_KINDS.has(rawCallerKind)) {
    return downgrade(`unsupported caller kind: ${rawCallerKind || "empty"}`, true)
  }

  if (claim.tier === "untrusted:community") {
    return downgrade("community execution")
  }

  if (!REPO_RE.test(repository)) {
    return downgrade("invalid repository identifier")
  }

  if (!SHA40_RE.test(commitSha)) {
    return downgrade("commit sha must be a full 40-character hex digest")
  }

  if (!ACTOR_RE.test(actor)) {
    return downgrade("invalid actor identifier")
  }

  const issuedMs = Date.parse(String(claim.issuedAt ?? ""))
  const expiresMs = Date.parse(String(claim.expiresAt ?? ""))
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return downgrade("invalid attestation timestamps")
  }
  if (expiresMs <= issuedMs) {
    return downgrade("attestation expiry precedes issuance")
  }
  if (now.getTime() >= expiresMs) {
    return downgrade("attestation has expired")
  }
  if (issuedMs > now.getTime() + 60_000) {
    return downgrade("attestation issued in the future")
  }

  if (!config.signingSecret || config.signingSecret.length < 16) {
    return downgrade("control plane signing secret unavailable")
  }

  if (typeof claim.attestation !== "string" || !/^[0-9a-f]{64}$/i.test(claim.attestation)) {
    return downgrade("missing or malformed cryptographic attestation")
  }

  const expectedMac = createHmac("sha256", config.signingSecret)
    .update(canonicalAttestationPayload(claim))
    .digest("hex")

  if (!constantTimeHexEqual(claim.attestation.toLowerCase(), expectedMac)) {
    return downgrade("attestation signature verification failed")
  }

  if (claim.tier === "trusted:maintainer") {
    if (!maintainers.has(actor)) {
      return downgrade(`actor ${actor} is not in the repository maintainers list`)
    }
    return {
      effectiveTier: "trusted:maintainer",
      claimedTier: claim.tier,
      callerKind: safeCallerKind,
      actor,
      repository,
      commitSha,
      sandboxId,
      trusted: true,
      downgraded: false,
      downgradeReason: null,
      verifiedAt: now.toISOString(),
      expiresAt: claim.expiresAt
    }
  }

  if (claim.tier === "trusted:sandbox") {
    if (!sandboxId || !sandboxPrefixes.some((prefix) => sandboxId.startsWith(prefix))) {
      return downgrade("sandbox identifier is not in the controlled sandbox fleet")
    }

    return {
      effectiveTier: "trusted:sandbox",
      claimedTier: claim.tier,
      callerKind: safeCallerKind,
      actor,
      repository,
      commitSha,
      sandboxId,
      trusted: true,
      downgraded: false,
      downgradeReason: null,
      verifiedAt: now.toISOString(),
      expiresAt: claim.expiresAt
    }
  }

  return downgrade("unrecognized trust tier", true)
}

export function evaluateExecutionPolicy(
  verified: VerifiedExecution,
  now?: Date
): ExecutionCapabilities {
  const referenceMs = now ? now.getTime() : Date.parse(verified.verifiedAt)
  const isExpired =
    typeof verified.expiresAt === "string" &&
    Number.isFinite(Date.parse(verified.expiresAt)) &&
    Number.isFinite(referenceMs) &&
    referenceMs >= Date.parse(verified.expiresAt)

  const commitValid = SHA40_RE.test(verified.commitSha)

  if (!isExpired && commitValid && verified.trusted === true && verified.effectiveTier === "trusted:maintainer") {
    return {
      allowExecution: true,
      allowCacheRead: true,
      allowCacheWrite: true,
      allowTrustedArtifactWrite: true,
      allowUntrustedArtifactWrite: true,
      canSatisfyGates: true,
      artifactNamespace: `trusted/${verified.commitSha.toLowerCase()}`,
      provenanceBadge: "TRUSTED MAINTAINER"
    }
  }

  if (!isExpired && commitValid && verified.trusted === true && verified.effectiveTier === "trusted:sandbox") {
    return {
      allowExecution: true,
      allowCacheRead: true,
      allowCacheWrite: true,
      allowTrustedArtifactWrite: true,
      allowUntrustedArtifactWrite: true,
      canSatisfyGates: true,
      artifactNamespace: `trusted/${verified.commitSha.toLowerCase()}`,
      provenanceBadge: "TRUSTED SANDBOX"
    }
  }

  return {
    allowExecution: true,
    allowCacheRead: true,
    allowCacheWrite: false,
    allowTrustedArtifactWrite: false,
    allowUntrustedArtifactWrite: true,
    canSatisfyGates: false,
    artifactNamespace: `untrusted/${sanitizeActor(verified.actor)}/${commitValid ? verified.commitSha.toLowerCase() : "workspace"}`,
    provenanceBadge: "UNTRUSTED COMMUNITY"
  }
}

export function evaluateGate(
  verified: VerifiedExecution,
  gateName: string,
  checksPassed: boolean
): GateCheckResult {
  const policy = evaluateExecutionPolicy(verified)
  if (!policy.canSatisfyGates) {
    return {
      gate: gateName,
      passed: checksPassed,
      satisfied: false,
      status: "untrusted_preview",
      trustTier: "untrusted:community",
      reason:
        "Untrusted community execution is encouraged for fast local feedback, but cannot satisfy required merge or release gates or write to the shared cache."
    }
  }
  if (!checksPassed) {
    return {
      gate: gateName,
      passed: false,
      satisfied: false,
      status: "failed",
      trustTier: verified.effectiveTier,
      reason: `Trusted ${verified.effectiveTier} execution failed gate ${gateName}.`
    }
  }
  return {
    gate: gateName,
    passed: true,
    satisfied: true,
    status: "passed",
    trustTier: verified.effectiveTier,
    reason: `Gate ${gateName} verified by ${verified.effectiveTier} (${verified.actor}).`
  }
}

export function createGateReceipt(
  verified: VerifiedExecution,
  gate: GateCheckResult,
  score: number
): GateReceipt {
  const policy = evaluateExecutionPolicy(verified)
  const satisfied = Boolean(gate.satisfied && policy.canSatisfyGates && verified.trusted)
  return {
    repository: verified.repository.trim().toLowerCase(),
    commitSha: verified.commitSha.trim().toLowerCase(),
    gate: gate.gate,
    score: Math.max(0, Math.min(100, Math.round(score))),
    passed: gate.passed,
    satisfied,
    trustTier: satisfied ? verified.effectiveTier : "untrusted:community",
    actor: verified.actor,
    verifiedAt: verified.verifiedAt
  }
}

export function verifyGateReceipt(
  receipt: GateReceipt | null | undefined,
  expected: { readonly repository: string; readonly commitSha: string; readonly minScore?: number }
): boolean {
  if (!receipt) return false
  if (!receipt.satisfied || !receipt.passed) return false
  if (receipt.trustTier !== "trusted:maintainer" && receipt.trustTier !== "trusted:sandbox") return false
  if (receipt.repository.trim().toLowerCase() !== expected.repository.trim().toLowerCase()) return false
  if (!SHA40_RE.test(receipt.commitSha) || receipt.commitSha.toLowerCase() !== expected.commitSha.trim().toLowerCase()) {
    return false
  }
  const minScore = expected.minScore ?? 90
  return Number.isFinite(receipt.score) && receipt.score >= minScore
}

export function authorizeAction(
  verified: VerifiedExecution,
  action: string
): ActionAuthorization {
  const isPersonOnly = (PERSON_ONLY_ACTIONS as ReadonlyArray<string>).includes(action)
  if (isPersonOnly && verified.callerKind !== "person") {
    return {
      allowed: false,
      code: "person_only",
      reason: `Action ${action} is person-only and cannot be executed by ${verified.callerKind} credentials.`
    }
  }

  if (isPersonOnly && (!verified.trusted || verified.effectiveTier !== "trusted:maintainer")) {
    return {
      allowed: false,
      code: "maintainer_required",
      reason: `Action ${action} requires a verified repository maintainer acting in person.`
    }
  }

  if (!isPersonOnly && !KNOWN_NON_PERSON_ACTIONS.has(action)) {
    return {
      allowed: false,
      code: "unknown_action",
      reason: `Unknown action ${action} is denied by default.`
    }
  }

  const policy = evaluateExecutionPolicy(verified)
  if (
    (action === "cache/write" || action === "artifact/publish-trusted" || action === "gate/satisfy") &&
    !policy.allowCacheWrite
  ) {
    return {
      allowed: false,
      code: "untrusted_write_forbidden",
      reason: `Untrusted execution (${verified.effectiveTier}) cannot perform ${action}.`
    }
  }

  return {
    allowed: true,
    code: "ok",
    reason: `Action ${action} permitted for ${verified.effectiveTier} (${verified.callerKind}).`
  }
}

export interface RootInputTraceRow {
  readonly privilegedStep: string
  readonly originInput: string
  readonly trustBoundary: string
  readonly enforcementMechanism: string
  readonly untrustedCanBypass: false
}

/**
 * Root-input-tracing table documenting every privileged action in smithers-ci
 * back to its exact origin input and control-plane enforcement boundary.
 */
export const ROOT_INPUT_TRACING_TABLE: ReadonlyArray<RootInputTraceRow> = [
  {
    privilegedStep: "Shared Object Store Cache Write (/ac, /cas)",
    originInput: "HMAC-signed ExecutionClaim + server-minted cache:write scope",
    trustBoundary: "ExecutionTrust.verifyExecutionTrust + ObjectStore.putCache",
    enforcementMechanism: "Constant-time HMAC verification + exhaustive tier check (trusted:maintainer | trusted:sandbox only)",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "Trusted Artifact Pointer Publication",
    originInput: "Verified ExecutionClaim + artifact:write:trusted scope + SHA-256 content digest",
    trustBoundary: "McpServer destination scope check + ObjectStore untrusted-cas isolation",
    enforcementMechanism: "Untrusted writes routed exclusively to untrusted-cas/ and untrusted/<actor>/<sha>/, never cas/ or trusted/",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "Merge / Release Gate Satisfaction",
    originInput: "AuditEngine commit-bound GateReceipt + verified ExecutionClaim",
    trustBoundary: "ExecutionTrust.evaluateGate + FactoryState.mergePull receipt verification",
    enforcementMechanism: "Requires trusted GateReceipt matching exact repository and head commit SHA; untrusted runs stay untrusted_preview",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "One-Time Sandbox Auth Token Minting & PKCE Exchange",
    originInput: "Maintainer identity + allowlisted scopes + RFC 7636 S256 challenge",
    trustBoundary: "OneTimeTokenStore + FactoryHubDO atomic SQLite transactionSync CAS",
    enforcementMechanism: "Single-use conditional UPDATE burn + atomic lease insert; scope intersection strips person-only and untrusted write scopes",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "Person-Only Actions (pr/merge, todo/commit, release/publish, secrets/write)",
    originInput: "Authenticated session callerKind + maintainer role",
    trustBoundary: "ExecutionTrust.authorizeAction (default-deny) + McpServer guard",
    enforcementMechanism: "403 person_only for all agent and sandbox tokens regardless of underlying user role",
    untrustedCanBypass: false
  }
]
