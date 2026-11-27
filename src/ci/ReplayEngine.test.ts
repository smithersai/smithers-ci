import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SharedObjectStore } from "../store/ObjectStore.ts"
import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"
import { formatReplayReport, runIncrementalReplay } from "./ReplayEngine.ts"

const SECRET = "replay-engine-test-secret-0123456789"
const SHA = "46412bca49c3a0f1234567890abcdef123456789"

describe("ReplayEngine (content-addressed incremental replay with trust isolation)", () => {
  it("populates shared cache on trusted cold run, achieves 100% warm hits with 0 mismatches on untrusted community run, and blocks untrusted cache writes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "smithers-replay-test-"))
    const store = new SharedObjectStore({ rootDir: tmp })
    const now = new Date()
    const issuedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 600_000).toISOString()

    const untrusted = verifyExecutionTrust({
      tier: "untrusted:community",
      callerKind: "person",
      actor: "alice-dev",
      repository: "smithersai/smithers-ci",
      commitSha: SHA,
      issuedAt,
      expiresAt
    })

    // 1. Untrusted cold run MUST execute cleanly but block ALL cache writes
    const coldUntrusted = runIncrementalReplay({
      repoRoot: process.cwd(),
      store,
      execution: untrusted
    })
    expect(coldUntrusted.totalTargets).toBe(9)
    expect(coldUntrusted.cacheHits).toBe(0)
    expect(coldUntrusted.cacheWritesPerformed).toBe(0)
    expect(coldUntrusted.cacheWritesBlocked).toBe(9)
    expect(store.stats().actionCacheEntries).toBe(0)

    // 2. Trusted sandbox cold run populates /ac and /cas
    const trusted = verifyExecutionTrust(
      signExecutionClaim(
        {
          tier: "trusted:sandbox",
          callerKind: "sandbox",
          actor: "cfbox-gate-04",
          repository: "smithersai/smithers-ci",
          commitSha: SHA,
          sandboxId: "cfbox-gate-04",
          issuedAt,
          expiresAt
        },
        SECRET
      ),
      { signingSecret: SECRET }
    )
    const coldTrusted = runIncrementalReplay({
      repoRoot: process.cwd(),
      store,
      execution: trusted
    })
    expect(coldTrusted.cacheHits).toBe(0)
    expect(coldTrusted.cacheWritesPerformed).toBe(9)
    expect(coldTrusted.mismatches).toBe(0)
    expect(store.stats().actionCacheEntries).toBe(9)

    // 3. Untrusted community warm replay gets 100% warm cache hits with 0 mismatches and > 5x speedup!
    const warmUntrusted = runIncrementalReplay({
      repoRoot: process.cwd(),
      store,
      execution: untrusted
    })
    expect(warmUntrusted.cacheHits).toBe(9)
    expect(warmUntrusted.hitRate).toBe(1)
    expect(warmUntrusted.mismatches).toBe(0)
    expect(warmUntrusted.cacheWritesPerformed).toBe(0)
    expect(warmUntrusted.speedupFactor).toBeGreaterThanOrEqual(5)
    expect(warmUntrusted.replayDigest).toBe(coldTrusted.replayDigest)

    const text = formatReplayReport(warmUntrusted)
    expect(text).toContain("UNTRUSTED COMMUNITY")
    expect(text).toContain("Mismatches: 0")
  })
})
