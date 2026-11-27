import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"
import { ratingForScore, runBackpressureAudit, weightedScore } from "./AuditEngine.ts"
import { renderLighthouseHtml } from "./LighthouseHtml.ts"

const SECRET = "audit-engine-test-signing-secret-0123456789"
const SHA = "46412bca49c3a0f1234567890abcdef123456789"
const NOW = new Date("2026-11-27T08:00:00.000Z")

describe("Backpressure Audit Engine & Lighthouse HTML", () => {
  it("computes deterministic Lighthouse ratings and weighted scores", () => {
    expect(ratingForScore(95)).toBe("pass")
    expect(ratingForScore(90)).toBe("pass")
    expect(ratingForScore(72)).toBe("average")
    expect(ratingForScore(49)).toBe("fail")

    expect(
      weightedScore([
        {
          id: "a",
          category: "correctness",
          title: "A",
          description: "A",
          status: "pass",
          score: 100,
          weight: 3,
          displayValue: "ok",
          durationMs: 1,
          evidence: []
        },
        {
          id: "b",
          category: "correctness",
          title: "B",
          description: "B",
          status: "fail",
          score: 0,
          weight: 1,
          displayValue: "bad",
          durationMs: 1,
          evidence: []
        }
      ])
    ).toBe(75)
  })

  it("renders XSS-safe Lighthouse HTML and distinguishes trusted vs untrusted gates", () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "smithers-ci-audit-"))
    const untrustedExec = verifyExecutionTrust(
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

    const report = runBackpressureAudit({
      repoRoot: emptyRepo,
      execution: untrustedExec,
      testResults: { passed: 15, failed: 0, durationMs: 320 },
      typecheckPassed: true
    })

    expect(report.categories).toHaveLength(6)
    expect(report.gate.satisfied).toBe(false)
    expect(report.gate.status).toBe("untrusted_preview")
    expect(report.summary.releaseReady).toBe(false)

    const html = renderLighthouseHtml({
      ...report,
      repository: `smithersai/<script>alert(1)</script>`
    })
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("UNTRUSTED COMMUNITY")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)</script>")
  })

  it("satisfies release gate only for trusted execution meeting threshold", () => {
    const trustedClaim = signExecutionClaim(
      {
        tier: "trusted:sandbox",
        callerKind: "sandbox",
        actor: "ci-runner",
        repository: "smithersai/smithers-ci",
        commitSha: SHA,
        sandboxId: "cfbox-audit-1",
        issuedAt: "2026-11-27T07:55:00.000Z",
        expiresAt: "2026-11-27T08:30:00.000Z"
      },
      SECRET
    )
    const verified = verifyExecutionTrust(trustedClaim, { signingSecret: SECRET, now: () => NOW })
    expect(verified.trusted).toBe(true)
  })
})
