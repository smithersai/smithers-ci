import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"
import { ratingForScore, runBackpressureAudit, weightedScore } from "./AuditEngine.ts"
import { EXAMPLE_COMMIT_SHA, createExampleTrustedAuditReport } from "./ExampleAudit.ts"
import { renderLighthouseHtml } from "./LighthouseHtml.ts"

const SECRET = "audit-engine-test-signing-secret-0123456789"
const SHA = "268dbdf0aadc1e633ebeeee543d5ea75fefcf647"
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
    try {
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
      expect(report.waterfall).toEqual([])

      const html = renderLighthouseHtml({
        ...report,
        repository: `smithersai/<script>alert(1)</script>`
      })
      expect(html).toContain("Content-Security-Policy")
      expect(html).toContain("UNTRUSTED COMMUNITY")
      expect(html).toContain("No timing waterfall measurements were recorded")
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
      expect(html).not.toContain("<script>alert(1)</script>")
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true })
    }
  })

  it("leaves unmeasured checks as warnings and requires measured typecheck and tests to satisfy a trusted gate", () => {
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

    const unmeasured = runBackpressureAudit({
      repoRoot: process.cwd(),
      execution: verified
    })
    expect(unmeasured.gate.satisfied).toBe(false)
    expect(unmeasured.summary.releaseReady).toBe(false)
    expect(unmeasured.waterfall).toEqual([])

    const noTests = runBackpressureAudit({
      repoRoot: process.cwd(),
      execution: verified,
      typecheckPassed: true
    })
    expect(noTests.gate.satisfied).toBe(false)
    expect(noTests.summary.releaseReady).toBe(false)

    const measured = runBackpressureAudit({
      repoRoot: process.cwd(),
      execution: verified,
      typecheckPassed: true,
      testResults: { passed: 40, failed: 0, durationMs: 700 },
      replayResults: { targets: 9, mismatches: 0, cacheHits: 9, speedupFactor: 4.0, durationMs: 500 },
      formalResults: { theorems: 10, sorryCount: 0, durationMs: 50 },
      fuzzResults: { suites: 1, passed: 7, failed: 0, durationMs: 120 }
    })
    expect(measured.overallScore).toBeGreaterThanOrEqual(90)
    expect(measured.gate.satisfied).toBe(true)
    expect(measured.gate.status).toBe("passed")
    expect(measured.summary.releaseReady).toBe(true)
  })

  it("keeps explicit example reports separate and clearly marked as examples", () => {
    const example = createExampleTrustedAuditReport({ repoRoot: process.cwd(), now: NOW })
    expect(example.isExample).toBe(true)
    expect(example.commitSha).toBe(EXAMPLE_COMMIT_SHA)
    expect(example.waterfall.length).toBeGreaterThan(0)

    const html = renderLighthouseHtml(example)
    expect(html).toContain("EXAMPLE REPORT")
    expect(html).toContain("Illustrative example fixture")
  })
})
