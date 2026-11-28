import type { CheckoutIdentity } from "../cli/CheckoutIdentity.ts"
import {
  VALID_TRUST_TIERS,
  type TrustTier,
  type VerifiedExecution,
  evaluateExecutionPolicy,
  sanitizeActor,
  verifyExecutionTrust
} from "./ExecutionTrust.ts"

const SHA40_RE = /^[0-9a-f]{40}$/i

export interface TrustReceiptVerificationRequest {
  readonly requestedTier: TrustTier | null
  readonly receiptPath: string | null
  readonly repository: string
  readonly commitSha: string
  readonly commitVerified: boolean
  readonly dirty: boolean | null
}

export type TrustReceiptVerificationFailureCode =
  | "missing_production_adapter"
  | "invalid_trust_tier"
  | "unverified_checkout_commit"
  | "dirty_checkout"
  | "receipt_required"
  | "receipt_rejected"
  | "identity_mismatch"

export type TrustReceiptVerificationResult =
  | {
      readonly ok: true
      readonly execution: VerifiedExecution
      readonly adapterId: string
    }
  | {
      readonly ok: false
      readonly code: TrustReceiptVerificationFailureCode
      readonly message: string
    }

export interface ExternalTrustReceiptAdapter {
  readonly id: string
  verifyReceipt(
    request: TrustReceiptVerificationRequest
  ): TrustReceiptVerificationResult | Promise<TrustReceiptVerificationResult>
}

export type CliExecutionTrustResolution =
  | {
      readonly ok: true
      readonly execution: VerifiedExecution
      readonly elevated: boolean
      readonly adapterId: string | null
    }
  | {
      readonly ok: false
      readonly code: TrustReceiptVerificationFailureCode
      readonly message: string
    }

export const MISSING_TRUST_RECEIPT_ADAPTER_MESSAGE =
  "Refusing elevated provenance: trusted:sandbox and trusted:maintainer require a genuine externally issued and externally verified trust receipt bound to the checkout repository and commit SHA. Local self-signing and ambient environment secrets cannot elevate CLI provenance. Missing integration: smithersai/smithers-ci currently includes only in-process ExecutionTrust HMAC primitives and has no production external trust-receipt verification adapter (for example, a Smithers Cloud control-plane verifier checking pinned asymmetric public keys or OIDC attestation bound to this checkout). Run without --trust (or pass --trust untrusted:community) for an honest local untrusted audit."

export async function resolveCliExecutionTrust(options: {
  readonly checkout: CheckoutIdentity
  readonly requestedTier?: string | null
  readonly receiptPath?: string | null
  readonly adapter?: ExternalTrustReceiptAdapter | null
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
}): Promise<CliExecutionTrustResolution> {
  const env = options.env ?? process.env
  const now = (options.now ?? (() => new Date()))()
  const rawTier = options.requestedTier?.trim() ?? ""
  const receiptPath = options.receiptPath?.trim() || null

  if (rawTier.length > 0 && !VALID_TRUST_TIERS.has(rawTier)) {
    return {
      ok: false,
      code: "invalid_trust_tier",
      message: `Unsupported trust tier "${rawTier}". Expected one of: untrusted:community, trusted:sandbox, trusted:maintainer.`
    }
  }

  const requestedTier: TrustTier | null = rawTier.length > 0 ? (rawTier as TrustTier) : null
  const wantsElevation =
    (requestedTier !== null && requestedTier !== "untrusted:community") || receiptPath !== null

  if (!wantsElevation) {
    const actor = sanitizeActor(env.USER ?? env.LOGNAME ?? "local-user")
    const issuedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 600_000).toISOString()
    const execution = verifyExecutionTrust(
      {
        tier: "untrusted:community",
        callerKind: "person",
        actor,
        repository: options.checkout.repository,
        commitSha: options.checkout.commitSha,
        sandboxId: null,
        issuedAt,
        expiresAt
      },
      { now: () => now }
    )
    return {
      ok: true,
      execution,
      elevated: false,
      adapterId: null
    }
  }

  if (!options.adapter) {
    return {
      ok: false,
      code: "missing_production_adapter",
      message: MISSING_TRUST_RECEIPT_ADAPTER_MESSAGE
    }
  }

  if (!options.checkout.commitVerified || !SHA40_RE.test(options.checkout.commitSha)) {
    return {
      ok: false,
      code: "unverified_checkout_commit",
      message: `Refusing elevated provenance: checkout commit "${options.checkout.commitSha}" could not be verified from local VCS metadata.`
    }
  }

  if (options.checkout.dirty === true) {
    return {
      ok: false,
      code: "dirty_checkout",
      message: "Refusing elevated provenance: working copy has uncommitted local changes."
    }
  }

  if (options.checkout.envCommitMismatch !== null) {
    return {
      ok: false,
      code: "identity_mismatch",
      message: `Refusing elevated provenance: environment commit SHA (${options.checkout.envCommitMismatch}) disagrees with actual checkout commit (${options.checkout.commitSha}).`
    }
  }

  if (!receiptPath) {
    return {
      ok: false,
      code: "receipt_required",
      message: `Refusing elevated provenance (${requestedTier ?? "trusted"}): pass --trust-receipt <path> referencing an externally issued trust receipt.`
    }
  }

  const verifiedResult = await options.adapter.verifyReceipt({
    requestedTier,
    receiptPath,
    repository: options.checkout.repository,
    commitSha: options.checkout.commitSha,
    commitVerified: options.checkout.commitVerified,
    dirty: options.checkout.dirty
  })

  if (!verifiedResult.ok) {
    return verifiedResult
  }

  const execution = verifiedResult.execution
  const policy = evaluateExecutionPolicy(execution, now)

  if (
    !execution.trusted ||
    !policy.canSatisfyGates ||
    (execution.effectiveTier !== "trusted:sandbox" && execution.effectiveTier !== "trusted:maintainer")
  ) {
    return {
      ok: false,
      code: "receipt_rejected",
      message: `External trust receipt adapter "${verifiedResult.adapterId}" did not establish an active trusted execution.`
    }
  }

  if (requestedTier !== null && execution.effectiveTier !== requestedTier) {
    return {
      ok: false,
      code: "identity_mismatch",
      message: `Trust receipt tier (${execution.effectiveTier}) does not match requested tier (${requestedTier}).`
    }
  }

  if (execution.repository.trim().toLowerCase() !== options.checkout.repository.trim().toLowerCase()) {
    return {
      ok: false,
      code: "identity_mismatch",
      message: `Trust receipt repository (${execution.repository}) does not match checkout repository (${options.checkout.repository}).`
    }
  }

  if (execution.commitSha.trim().toLowerCase() !== options.checkout.commitSha.trim().toLowerCase()) {
    return {
      ok: false,
      code: "identity_mismatch",
      message: `Trust receipt commit SHA (${execution.commitSha}) does not match checkout commit (${options.checkout.commitSha}).`
    }
  }

  return {
    ok: true,
    execution,
    elevated: true,
    adapterId: verifiedResult.adapterId
  }
}
