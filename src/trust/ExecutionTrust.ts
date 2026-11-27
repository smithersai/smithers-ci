import { createHmac, timingSafeEqual } from "node:crypto"

export type TrustTier =
  | "trusted:maintainer"
  | "trusted:sandbox"
  | "untrusted:community"

export type CallerKind = "person" | "agent" | "sandbox"

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

export interface ActionAuthorization {
  readonly allowed: boolean
  readonly code: "ok" | "person_only" | "untrusted_write_forbidden" | "maintainer_required"
  readonly reason: string
}

const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ACTOR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/

export function sanitizeActor(actor: string): string {
  const cleaned = actor.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const collapsed = cleaned.replace(/-+/g, "-").replace(/^-|-$/g, "")
  return collapsed.length > 0 ? collapsed.slice(0, 63) : "anonymous"
}

export function canonicalAttestationPayload(claim: Omit<ExecutionClaim, "attestation">): string {
  return JSON.stringify({
    tier: claim.tier,
    callerKind: claim.callerKind,
    actor: claim.actor.trim().toLowerCase(),
    repository: claim.repository.trim().toLowerCase(),
    commitSha: claim.commitSha.trim().toLowerCase(),
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
  const actor = sanitizeActor(claim.actor)
  const repository = claim.repository.trim().toLowerCase()
  const commitSha = claim.commitSha.trim().toLowerCase()
  const sandboxId = claim.sandboxId ? claim.sandboxId.trim() : null

  const downgrade = (reason: string): VerifiedExecution => ({
    effectiveTier: "untrusted:community",
    claimedTier: claim.tier,
    callerKind: claim.callerKind,
    actor,
    repository,
    commitSha,
    sandboxId,
    trusted: false,
    downgraded: claim.tier !== "untrusted:community",
    downgradeReason: claim.tier === "untrusted:community" ? null : reason,
    verifiedAt: now.toISOString()
  })

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

  const issuedMs = Date.parse(claim.issuedAt)
  const expiresMs = Date.parse(claim.expiresAt)
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return downgrade("invalid attestation timestamps")
  }
  if (expiresMs <= issuedMs) {
    return downgrade("attestation expiry precedes issuance")
  }
  if (now.getTime() > expiresMs) {
    return downgrade("attestation has expired")
  }
  if (issuedMs > now.getTime() + 60_000) {
    return downgrade("attestation issued in the future")
  }

  if (!config.signingSecret || config.signingSecret.length < 16) {
    return downgrade("control plane signing secret unavailable")
  }

  if (!claim.attestation || !/^[0-9a-f]{64}$/i.test(claim.attestation)) {
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
      callerKind: claim.callerKind,
      actor,
      repository,
      commitSha,
      sandboxId,
      trusted: true,
      downgraded: false,
      downgradeReason: null,
      verifiedAt: now.toISOString()
    }
  }

  // trusted:sandbox
  if (!sandboxId || !sandboxPrefixes.some((prefix) => sandboxId.startsWith(prefix))) {
    return downgrade("sandbox identifier is not in the controlled sandbox fleet")
  }

  return {
    effectiveTier: "trusted:sandbox",
    claimedTier: claim.tier,
    callerKind: claim.callerKind,
    actor,
    repository,
    commitSha,
    sandboxId,
    trusted: true,
    downgraded: false,
    downgradeReason: null,
    verifiedAt: now.toISOString()
  }
}

export function evaluateExecutionPolicy(verified: VerifiedExecution): ExecutionCapabilities {
  if (verified.effectiveTier === "trusted:maintainer") {
    return {
      allowExecution: true,
      allowCacheRead: true,
      allowCacheWrite: true,
      allowTrustedArtifactWrite: true,
      allowUntrustedArtifactWrite: true,
      canSatisfyGates: true,
      artifactNamespace: `trusted/${verified.commitSha}`,
      provenanceBadge: "TRUSTED MAINTAINER"
    }
  }

  if (verified.effectiveTier === "trusted:sandbox") {
    return {
      allowExecution: true,
      allowCacheRead: true,
      allowCacheWrite: true,
      allowTrustedArtifactWrite: true,
      allowUntrustedArtifactWrite: true,
      canSatisfyGates: true,
      artifactNamespace: `trusted/${verified.commitSha}`,
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
    artifactNamespace: `untrusted/${sanitizeActor(verified.actor)}/${verified.commitSha || "workspace"}`,
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
      trustTier: verified.effectiveTier,
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

  if (isPersonOnly && verified.effectiveTier !== "trusted:maintainer") {
    return {
      allowed: false,
      code: "maintainer_required",
      reason: `Action ${action} requires a verified repository maintainer acting in person.`
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
    enforcementMechanism: "Constant-time HMAC verification + tier check (trusted:maintainer | trusted:sandbox only)",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "Trusted Artifact Pointer Publication",
    originInput: "Verified ExecutionClaim + SHA-256 content digest",
    trustBoundary: "ObjectStore.putArtifact namespace isolation",
    enforcementMechanism: "Untrusted writes routed exclusively to untrusted/<actor>/<sha>/, never trusted/",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "Merge / Release Gate Satisfaction",
    originInput: "AuditEngine report + verified ExecutionClaim",
    trustBoundary: "ExecutionTrust.evaluateGate",
    enforcementMechanism: "Hard returns satisfied: false and status: untrusted_preview for untrusted:community",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "One-Time Sandbox Auth Token Minting",
    originInput: "Maintainer identity + scope request",
    trustBoundary: "OneTimeTokenStore.mint",
    enforcementMechanism: "Scope intersection strips person-only actions and strips cache:write for untrusted tiers",
    untrustedCanBypass: false
  },
  {
    privilegedStep: "Person-Only Actions (pr/merge, todo/commit, release/publish, secrets/write)",
    originInput: "Authenticated session callerKind + maintainer role",
    trustBoundary: "ExecutionTrust.authorizeAction + McpServer guard",
    enforcementMechanism: "403 person_only for all agent and sandbox tokens regardless of underlying user role",
    untrustedCanBypass: false
  }
]
