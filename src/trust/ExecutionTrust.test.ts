import { describe, expect, it } from "vitest"
import {
  PERSON_ONLY_ACTIONS,
  ROOT_INPUT_TRACING_TABLE,
  authorizeAction,
  evaluateExecutionPolicy,
  evaluateGate,
  signExecutionClaim,
  verifyExecutionTrust
} from "./ExecutionTrust.ts"

const SECRET = "test-control-plane-signing-secret-0123456789"
const SHA = "46412bca49c3a0f1234567890abcdef123456789"
const NOW = new Date("2026-11-27T08:00:00.000Z")

describe("ExecutionTrust", () => {
  it("accepts a cryptographically signed maintainer claim", () => {
    const claim = signExecutionClaim(
      {
        tier: "trusted:maintainer",
        callerKind: "person",
        actor: "roninjin10",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        issuedAt: "2026-11-27T07:55:00.000Z",
        expiresAt: "2026-11-27T08:30:00.000Z"
      },
      SECRET
    )

    const verified = verifyExecutionTrust(claim, { signingSecret: SECRET, now: () => NOW })
    expect(verified.effectiveTier).toBe("trusted:maintainer")
    expect(verified.trusted).toBe(true)
    expect(verified.downgraded).toBe(false)

    const policy = evaluateExecutionPolicy(verified)
    expect(policy.allowCacheWrite).toBe(true)
    expect(policy.canSatisfyGates).toBe(true)
    expect(policy.provenanceBadge).toBe("TRUSTED MAINTAINER")

    const gate = evaluateGate(verified, "release-audit", true)
    expect(gate.satisfied).toBe(true)
    expect(gate.status).toBe("passed")
  })

  it("accepts a cryptographically signed controlled sandbox claim", () => {
    const claim = signExecutionClaim(
      {
        tier: "trusted:sandbox",
        callerKind: "sandbox",
        actor: "ci-runner",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        sandboxId: "cfbox-019a7b2c",
        issuedAt: "2026-11-27T07:59:00.000Z",
        expiresAt: "2026-11-27T08:20:00.000Z"
      },
      SECRET
    )

    const verified = verifyExecutionTrust(claim, { signingSecret: SECRET, now: () => NOW })
    expect(verified.effectiveTier).toBe("trusted:sandbox")
    expect(verified.trusted).toBe(true)

    const policy = evaluateExecutionPolicy(verified)
    expect(policy.allowCacheWrite).toBe(true)
    expect(policy.canSatisfyGates).toBe(true)
    expect(policy.provenanceBadge).toBe("TRUSTED SANDBOX")
  })

  it("downgrades forged maintainer or sandbox claims to untrusted:community", () => {
    const forged = {
      tier: "trusted:maintainer" as const,
      callerKind: "person" as const,
      actor: "roninjin10",
      repository: "smithersai/smithers-ci",
      commitSha: SHA,
      issuedAt: "2026-11-27T07:55:00.000Z",
      expiresAt: "2026-11-27T08:30:00.000Z",
      attestation: "a".repeat(64)
    }

    const verified = verifyExecutionTrust(forged, { signingSecret: SECRET, now: () => NOW })
    expect(verified.effectiveTier).toBe("untrusted:community")
    expect(verified.trusted).toBe(false)
    expect(verified.downgraded).toBe(true)
    expect(verified.downgradeReason).toContain("signature")

    const policy = evaluateExecutionPolicy(verified)
    expect(policy.allowExecution).toBe(true)
    expect(policy.allowCacheRead).toBe(true)
    expect(policy.allowCacheWrite).toBe(false)
    expect(policy.allowTrustedArtifactWrite).toBe(false)
    expect(policy.canSatisfyGates).toBe(false)
  })

  it("downgrades signed claim for non-maintainer actor or uncontrolled sandbox", () => {
    const nonMaintainer = signExecutionClaim(
      {
        tier: "trusted:maintainer",
        callerKind: "person",
        actor: "random-contributor",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        issuedAt: "2026-11-27T07:55:00.000Z",
        expiresAt: "2026-11-27T08:30:00.000Z"
      },
      SECRET
    )
    const verifiedNonMaintainer = verifyExecutionTrust(nonMaintainer, { signingSecret: SECRET, now: () => NOW })
    expect(verifiedNonMaintainer.effectiveTier).toBe("untrusted:community")
    expect(verifiedNonMaintainer.downgraded).toBe(true)

    const rogueSandbox = signExecutionClaim(
      {
        tier: "trusted:sandbox",
        callerKind: "sandbox",
        actor: "ci-runner",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        sandboxId: "untrusted-laptop-box",
        issuedAt: "2026-11-27T07:55:00.000Z",
        expiresAt: "2026-11-27T08:30:00.000Z"
      },
      SECRET
    )
    const verifiedRogue = verifyExecutionTrust(rogueSandbox, { signingSecret: SECRET, now: () => NOW })
    expect(verifiedRogue.effectiveTier).toBe("untrusted:community")
    expect(verifiedRogue.downgraded).toBe(true)
  })

  it("encourages untrusted community runs while strictly preventing gate bypass", () => {
    const verified = verifyExecutionTrust(
      {
        tier: "untrusted:community",
        callerKind: "person",
        actor: "alice-dev",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        issuedAt: "2026-11-27T07:55:00.000Z",
        expiresAt: "2026-11-27T08:30:00.000Z"
      },
      { signingSecret: SECRET, now: () => NOW }
    )

    const policy = evaluateExecutionPolicy(verified)
    expect(policy.allowExecution).toBe(true)
    expect(policy.allowCacheRead).toBe(true)
    expect(policy.allowUntrustedArtifactWrite).toBe(true)
    expect(policy.allowCacheWrite).toBe(false)
    expect(policy.canSatisfyGates).toBe(false)
    expect(policy.artifactNamespace).toBe(`untrusted/alice-dev/${SHA}`)

    const gate = evaluateGate(verified, "lighthouse-backpressure", true)
    expect(gate.passed).toBe(true)
    expect(gate.satisfied).toBe(false)
    expect(gate.status).toBe("untrusted_preview")
  })

  it("refuses person-only actions for agents and sandboxes even with maintainer tier", () => {
    const agentClaim = signExecutionClaim(
      {
        tier: "trusted:maintainer",
        callerKind: "agent",
        actor: "roninjin10",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        issuedAt: "2026-11-27T07:55:00.000Z",
        expiresAt: "2026-11-27T08:30:00.000Z"
      },
      SECRET
    )
    const verifiedAgent = verifyExecutionTrust(agentClaim, { signingSecret: SECRET, now: () => NOW })

    for (const action of PERSON_ONLY_ACTIONS) {
      const auth = authorizeAction(verifiedAgent, action)
      expect(auth.allowed).toBe(false)
      expect(auth.code).toBe("person_only")
    }
  })

  it("maintains complete root-input-tracing security table with zero bypass paths", () => {
    expect(ROOT_INPUT_TRACING_TABLE.length).toBeGreaterThanOrEqual(5)
    for (const row of ROOT_INPUT_TRACING_TABLE) {
      expect(row.untrustedCanBypass).toBe(false)
    }
  })
})
