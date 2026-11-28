import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"
import {
  type BackpressureAuditReport,
  type TimingWaterfallStep,
  runBackpressureAudit
} from "./AuditEngine.ts"

/**
 * Explicit illustrative example fixtures, kept strictly separate from real CLI
 * audit runs and live checkout provenance.
 */
export const EXAMPLE_COMMIT_SHA = "46412bca49c3a0f1234567890abcdef123456789"

export const EXAMPLE_TIMING_WATERFALL: ReadonlyArray<TimingWaterfallStep> = [
  { name: "typecheck (tsc --noEmit)", category: "correctness", baselineMs: 1840, cachedMs: 190, cacheHit: true },
  { name: "unit & security suites", category: "correctness", baselineMs: 4120, cachedMs: 680, cacheHit: true },
  { name: "smthrs-observe replay parity", category: "cache-speed", baselineMs: 12900, cachedMs: 2900, cacheHit: true },
  { name: "trust & token adversarial checks", category: "security-trust", baselineMs: 920, cachedMs: 110, cacheHit: true },
  { name: "wiki links & mythical history", category: "wiki-docs", baselineMs: 640, cachedMs: 42, cacheHit: true },
  { name: "home.json & cloud triggers", category: "release-cloud", baselineMs: 380, cachedMs: 28, cacheHit: true }
]

/**
 * Builds a clearly marked synthetic example of what a trusted sandbox report looks
 * like once an external trust receipt verifier and full measured checks are supplied.
 * Never use this for live checkout verification, CLI audit output, or merge gates.
 */
export function createExampleTrustedAuditReport(options: {
  readonly repoRoot: string
  readonly now?: Date
}): BackpressureAuditReport {
  const now = options.now ?? new Date()
  const issuedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 600_000).toISOString()
  const exampleSecret = "example-only-non-production-fixture-key"

  const exampleExec = verifyExecutionTrust(
    signExecutionClaim(
      {
        tier: "trusted:sandbox",
        callerKind: "sandbox",
        actor: "cfbox-example-01",
        repository: "smithersai/smithers-ci",
        commitSha: EXAMPLE_COMMIT_SHA,
        sandboxId: "cfbox-example-01",
        issuedAt,
        expiresAt
      },
      exampleSecret
    ),
    { signingSecret: exampleSecret, now: () => now }
  )

  return runBackpressureAudit({
    repoRoot: options.repoRoot,
    execution: exampleExec,
    typecheckPassed: true,
    typecheckDurationMs: 190,
    testResults: { passed: 36, failed: 0, durationMs: 680 },
    replayResults: {
      targets: 9,
      mismatches: 0,
      cacheHits: 9,
      speedupFactor: 4.4,
      durationMs: 2900,
      evidence: ["Illustrative example fixture (not measured on the current checkout)"]
    },
    formalResults: {
      theorems: 387,
      sorryCount: 0,
      packages: 6,
      files: 51,
      durationMs: 95,
      evidence: ["Illustrative example fixture (external Lean 4 reference suite)"]
    },
    fuzzResults: {
      suites: 1,
      passed: 7,
      failed: 0,
      durationMs: 124,
      evidence: ["Illustrative example fixture (not measured on the current checkout)"]
    },
    waterfall: EXAMPLE_TIMING_WATERFALL,
    isExample: true
  })
}
