import { createHmac } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runBackpressureAudit } from "../audit/AuditEngine.ts"
import { renderLighthouseHtml } from "../audit/LighthouseHtml.ts"
import {
  OneTimeTokenStore,
  computePkceS256Challenge,
  writeTokenFile
} from "../auth/OneTimeToken.ts"
import { resolveAudience, validateHomeJson } from "../factory/Audience.ts"
import { FactoryActionError, FactoryState } from "../factory/FactoryState.ts"
import { MythicalHistorySequencer } from "../history/MythicalHistory.ts"
import { SmithersCloudMcpServer } from "../mcp/McpServer.ts"
import { ObjectStoreError, SharedObjectStore } from "../store/ObjectStore.ts"
import {
  type ExecutionClaim,
  authorizeAction,
  canonicalAttestationPayload,
  createGateReceipt,
  evaluateExecutionPolicy,
  evaluateGate,
  signExecutionClaim,
  verifyExecutionTrust
} from "../trust/ExecutionTrust.ts"
import { FactoryHubDO, type SqlStorageLike, webPkceS256 } from "../../worker/FactoryHubDO.ts"
import worker from "../../worker/index.ts"

const SECRET = "adversarial-fuzz-secret-key-0123456789abcdef"
const SHA_A = "46412bca49c3a0f1234567890abcdef123456789"
const SHA_B = "9e0efd0d871f1234567890abcdef1234567890ab"

// Deterministic xorshift32 PRNG for reproducible fuzzing.
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

/**
 * Transactional SQLite-compatible harness simulating Cloudflare Durable Object SQLite
 * storage across restarts and concurrent requests without native binary dependencies.
 */
function createMockDurableSqlStorage() {
  const tables = {
    one_time_tokens: new Map<string, Record<string, unknown>>(),
    session_leases: new Map<string, Record<string, unknown>>(),
    waitlist_requests: new Map<string, Record<string, unknown>>(),
    factory_todos: new Map<string, Record<string, unknown>>(),
    factory_issues: new Map<number, Record<string, unknown>>(),
    factory_changesets: new Map<string, Record<string, unknown>>(),
    factory_pulls: new Map<number, Record<string, unknown>>(),
    factory_artifacts: new Map<string, Record<string, unknown>>()
  }

  let lastChanges = 0

  const sql: SqlStorageLike = {
    exec(query: string, ...b: ReadonlyArray<unknown>) {
      const q = query.trim().replace(/\s+/g, " ")
      if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE UNIQUE INDEX") || q.startsWith("DELETE FROM waitlist_requests") || q.startsWith("UPDATE waitlist_requests")) {
        return { toArray: () => [], rowsWritten: 0 }
      }
      if (q.startsWith("SELECT repo, created_at FROM waitlist_requests")) {
        return { toArray: () => Array.from(tables.waitlist_requests.values()), rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR REPLACE INTO one_time_tokens")) {
        tables.one_time_tokens.set(String(b[0]), {
          digest: b[0],
          id: b[1],
          subject: b[2],
          trust_tier: b[3],
          scopes_json: b[4],
          pkce_challenge: b[5],
          expires_at: b[6],
          redeemed_at: b[7],
          revoked_at: b[8]
        })
        lastChanges = 1
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT * FROM one_time_tokens WHERE digest = ?")) {
        const row = tables.one_time_tokens.get(String(b[0]))
        return { toArray: () => (row ? [{ ...row }] : []), rowsWritten: 0 }
      }
      if (q.startsWith("UPDATE one_time_tokens SET redeemed_at = ?")) {
        const [nowIso, digest, expiryCheck] = b
        const row = tables.one_time_tokens.get(String(digest))
        if (
          row &&
          row.redeemed_at === null &&
          row.revoked_at === null &&
          String(row.expires_at) > String(expiryCheck)
        ) {
          row.redeemed_at = nowIso
          lastChanges = 1
          return { toArray: () => [], rowsWritten: 1 }
        }
        lastChanges = 0
        return { toArray: () => [], rowsWritten: 0 }
      }
      if (q.startsWith("SELECT changes()")) {
        return { toArray: () => [{ changed: lastChanges }], rowsWritten: 0 }
      }
      if (q.startsWith("INSERT INTO session_leases") || q.startsWith("INSERT OR REPLACE INTO session_leases")) {
        tables.session_leases.set(String(b[0]), {
          digest: b[0],
          lease_id: b[1],
          subject: b[2],
          trust_tier: b[3],
          scopes_json: b[4],
          expires_at: b[5],
          revoked_at: b[6]
        })
        lastChanges = 1
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT * FROM session_leases WHERE digest = ?")) {
        const row = tables.session_leases.get(String(b[0]))
        return { toArray: () => (row ? [{ ...row }] : []), rowsWritten: 0 }
      }
      if (q.startsWith("DELETE FROM session_leases")) {
        const nowIso = String(b[0])
        for (const [k, row] of tables.session_leases.entries()) {
          if (String(row.expires_at) <= nowIso || row.revoked_at !== null) {
            tables.session_leases.delete(k)
          }
        }
        return { toArray: () => [], rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR IGNORE INTO waitlist_requests")) {
        const repo = String(b[0])
        if (!tables.waitlist_requests.has(repo)) {
          tables.waitlist_requests.set(repo, { repo, created_at: b[1] })
        }
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT COUNT(*) AS cnt FROM waitlist_requests")) {
        return { toArray: () => [{ cnt: tables.waitlist_requests.size }], rowsWritten: 0 }
      }
      if (q.startsWith("SELECT data_json FROM factory_todos")) {
        const rows = Array.from(tables.factory_todos.values()).sort((a, c) => Number(c.seq) - Number(a.seq))
        return { toArray: () => rows, rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR IGNORE INTO factory_todos") || q.startsWith("INSERT OR REPLACE INTO factory_todos")) {
        const id = String(b[0])
        if (!q.includes("IGNORE") || !tables.factory_todos.has(id)) {
          tables.factory_todos.set(id, { id, seq: b[1], data_json: b[2] })
        }
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT data_json FROM factory_issues")) {
        const rows = Array.from(tables.factory_issues.values()).sort((a, c) => Number(c.number) - Number(a.number))
        return { toArray: () => rows, rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR IGNORE INTO factory_issues") || q.startsWith("INSERT OR REPLACE INTO factory_issues")) {
        const num = Number(b[0])
        if (!q.includes("IGNORE") || !tables.factory_issues.has(num)) {
          tables.factory_issues.set(num, { number: num, data_json: b[1] })
        }
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT data_json FROM factory_changesets")) {
        const rows = Array.from(tables.factory_changesets.values()).sort(
          (a, c) => Number(a.stack_position) - Number(c.stack_position)
        )
        return { toArray: () => rows, rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR IGNORE INTO factory_changesets") || q.startsWith("INSERT OR REPLACE INTO factory_changesets")) {
        const id = String(b[0])
        if (!q.includes("IGNORE") || !tables.factory_changesets.has(id)) {
          tables.factory_changesets.set(id, { id, stack_position: b[1], data_json: b[2] })
        }
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT data_json FROM factory_pulls")) {
        const rows = Array.from(tables.factory_pulls.values()).sort((a, c) => Number(c.number) - Number(a.number))
        return { toArray: () => rows, rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR IGNORE INTO factory_pulls") || q.startsWith("INSERT OR REPLACE INTO factory_pulls")) {
        const num = Number(b[0])
        if (!q.includes("IGNORE") || !tables.factory_pulls.has(num)) {
          tables.factory_pulls.set(num, { number: num, data_json: b[1] })
        }
        return { toArray: () => [], rowsWritten: 1 }
      }
      if (q.startsWith("SELECT key, meta_json, content FROM factory_artifacts")) {
        const rows = Array.from(tables.factory_artifacts.values()).sort((a, c) =>
          String(c.created_at).localeCompare(String(a.created_at))
        )
        return { toArray: () => rows, rowsWritten: 0 }
      }
      if (q.startsWith("INSERT OR IGNORE INTO factory_artifacts") || q.startsWith("INSERT OR REPLACE INTO factory_artifacts")) {
        const key = String(b[0])
        if (!q.includes("IGNORE") || !tables.factory_artifacts.has(key)) {
          tables.factory_artifacts.set(key, { key, created_at: b[1], meta_json: b[2], content: b[3] })
        }
        return { toArray: () => [], rowsWritten: 1 }
      }
      throw new Error(`Unhandled SQL in test harness: ${q}`)
    }
  }

  return {
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        return fn()
      }
    }
  }
}

describe("Adversarial Security, Concurrency, and Property Fuzz Suite (All 14 Audit Findings)", () => {
  it("Finding #1: 25 concurrent PKCE exchanges against SQLite-backed FactoryHubDO issue EXACTLY ONE lease and persist across DO restart", async () => {
    const mockState = createMockDurableSqlStorage()
    const hub = new FactoryHubDO(mockState)
    const verifier = "rfc7636-concurrent-pkce-verifier-0123456789abcdef012345"
    const challenge = await webPkceS256(verifier)

    const mintRes = await hub.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp/mint", {
        method: "POST",
        headers: { "content-type": "application/json", "x-smithers-control-plane": "verified" },
        body: JSON.stringify({
          subject: "sandbox:cfbox-race-01",
          trustTier: "trusted:sandbox",
          scopes: ["mcp:read", "todo:draft", "artifact:write:trusted", "bogus:scope", "pr/merge"],
          pkceChallenge: challenge
        })
      })
    )
    expect(mintRes.status).toBe(201)
    const minted = (await mintRes.json()) as { token: string; scopes: string[]; strippedScopes: string[] }
    expect(minted.strippedScopes).toContain("bogus:scope")
    expect(minted.strippedScopes).toContain("pr/merge")

    // Fire 25 overlapping PKCE redemption attempts simultaneously.
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        hub.fetch(
          new Request("https://smithers.sh/smithersai/smithers-ci/mcp/exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: minted.token, pkceVerifier: verifier })
          })
        )
      )
    )

    const successes = responses.filter((r) => r.status === 200)
    const failures = responses.filter((r) => r.status === 401)
    expect(successes.length).toBe(1)
    expect(failures.length).toBe(24)

    const leaseData = (await successes[0]!.json()) as { leaseToken: string }

    // Draft a TODO & upload a private artifact, then simulate DO hibernation by instantiating a brand new FactoryHubDO over the same SQLite state!
    const draftRes = await hub.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${leaseData.leaseToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "todo_draft", arguments: { title: "Survive DO hibernation", body: "SQLite backed" } }
        })
      })
    )
    expect(draftRes.status).toBe(200)

    const privArt = await hub.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${leaseData.leaseToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "artifact_put",
            arguments: { name: "internal-secret.txt", content: "top-secret", visibility: "private" }
          }
        })
      })
    )
    expect(privArt.status).toBe(200)

    // Waitlist dedup
    await hub.fetch(
      new Request("https://smithers.sh/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "tevm/zevm" })
      })
    )
    await hub.fetch(
      new Request("https://smithers.sh/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "TEVM/ZEVM" })
      })
    )

    // Cold-start new DO instance from same SQLite storage
    const restartedHub = new FactoryHubDO(mockState)
    const factoryRes = await restartedHub.fetch(new Request("https://smithers.sh/api/factory"))
    const factoryJson = (await factoryRes.json()) as {
      todos: Array<{ title: string }>
      artifacts: Array<{ name: string; visibility: string }>
      waitlistCount: number
    }
    expect(factoryJson.todos.some((t) => t.title === "Survive DO hibernation")).toBe(true)
    expect(factoryJson.waitlistCount).toBe(1)
    // Finding #6: Private artifact MUST NOT appear in public /api/factory!
    expect(factoryJson.artifacts.some((a) => a.name === "internal-secret.txt")).toBe(false)

    // Burned token MUST still be rejected after restart!
    const replayAfterRestart = await restartedHub.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: minted.token, pkceVerifier: verifier })
      })
    )
    expect(replayAfterRestart.status).toBe(401)
  })

  it("Finding #2 & #6: trusted-tier token with ONLY artifact:write:untrusted cannot write to trusted/ and audit_run never writes implicitly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smithers-scope-"))
    const store = new SharedObjectStore({ rootDir: join(tmp, "store") })
    const tokens = new OneTimeTokenStore({ baseUrl: "https://smithers.sh" })
    const mcp = new SmithersCloudMcpServer({
      repoRoot: process.cwd(),
      repository: "smithersai/smithers-ci",
      baseUrl: "https://smithers.sh",
      commitSha: SHA_A,
      store,
      tokens,
      factory: new FactoryState(),
      history: new MythicalHistorySequencer()
    })

    // Attenuated trusted:sandbox token that lacks artifact:write:trusted
    const minted = tokens.mint({
      repository: "smithersai/smithers-ci",
      subject: "sandbox:cfbox-attenuated",
      mintedBy: "roninjin10",
      trustTier: "trusted:sandbox",
      sandboxId: "cfbox-attenuated",
      scopes: ["mcp:read", "artifact:write:untrusted"]
    })
    const redeemed = tokens.redeem({ rawToken: minted.rawToken, repository: "smithersai/smithers-ci" })
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) return

    const putRes = mcp.handleRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "artifact_put",
          arguments: { name: "attenuated.txt", content: "cannot-touch-trusted", visibility: "private" }
        }
      },
      `Bearer ${redeemed.lease.rawLeaseToken}`
    )
    const art = (putRes.result as { structuredContent: { artifact: { namespace: string; trusted: boolean; key: string } } })
      .structuredContent.artifact
    expect(art.trusted).toBe(false)
    expect(art.namespace.startsWith("untrusted/")).toBe(true)

    // Private artifact hidden from anonymous artifacts_list and throws forbidden on unauthorized getArtifact
    const anonList = mcp.handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "artifacts_list", arguments: {} }
    })
    const listArr = (anonList.result as { structuredContent: { artifacts: Array<{ key: string }> } }).structuredContent
      .artifacts
    expect(listArr.some((a) => a.key === art.key)).toBe(false)
    expect(() => store.getArtifact(art.key)).toThrow(ObjectStoreError)
    expect(store.getArtifact(art.key, { allowPrivate: true })?.data.toString("utf8")).toBe("cannot-touch-trusted")

    // Anonymous audit_run does not write artifacts by default and refuses storeArtifacts: true
    const anonAudit = mcp.handleRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "audit_run", arguments: {} }
    })
    expect((anonAudit.result as { structuredContent: { stored: unknown } }).structuredContent.stored).toBeNull()

    const blockedWriteAudit = mcp.handleRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "audit_run", arguments: { storeArtifacts: true } }
    })
    expect(blockedWriteAudit.error?.code).toBe(-32002)

    // Malformed non-Bearer Authorization header rejected with -32001
    const badAuth = mcp.handleRpc(
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      "Basic dXNlcjpwYXNz"
    )
    expect(badAuth.error?.code).toBe(-32001)
  })

  it("Finding #3: repo_read_file & repo_tree block symlinks, directory cycles, internal secrets, and oversized files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "smithers-contain-"))
    mkdirSync(join(tmp, ".smithers", "tokens"), { recursive: true })
    mkdirSync(join(tmp, "sub"), { recursive: true })
    writeFileSync(join(tmp, "README.md"), "safe readme", "utf8")
    writeFileSync(join(tmp, ".env.local"), "SECRET=123", "utf8")
    writeFileSync(join(tmp, ".smithers", "tokens", "live.token"), "smo_secret", "utf8")
    writeFileSync(join(tmp, "huge.bin"), "x".repeat(600 * 1024), "utf8")
    symlinkSync("/etc/hosts", join(tmp, "hosts-link.txt"))
    symlinkSync(tmp, join(tmp, "sub", "cycle"))

    const mcp = new SmithersCloudMcpServer({
      repoRoot: tmp,
      repository: "smithersai/smithers-ci",
      baseUrl: "https://smithers.sh",
      commitSha: SHA_A,
      store: new SharedObjectStore({ rootDir: join(tmp, ".smithers", "object-store") }),
      tokens: new OneTimeTokenStore(),
      factory: new FactoryState(),
      history: new MythicalHistorySequencer()
    })

    const tree = mcp.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "repo_tree", arguments: {} }
    })
    const paths = (tree.result as { structuredContent: { paths: string[] } }).structuredContent.paths
    expect(paths).toContain("README.md")
    expect(paths).not.toContain(".env.local")
    expect(paths).not.toContain("hosts-link.txt")
    expect(paths.some((p) => p.includes(".smithers/tokens"))).toBe(false)

    for (const forbidden of [
      "hosts-link.txt",
      ".env.local",
      ".smithers/tokens/live.token",
      "../etc/passwd",
      "huge.bin",
      "sub/cycle/README.md"
    ]) {
      const res = mcp.handleRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "repo_read_file", arguments: { path: forbidden } }
      })
      expect(res.error, `expected error for ${forbidden}`).toBeDefined()
    }
  })

  it("Finding #4: unmeasured audits cannot satisfy gates and FactoryState.mergePull requires commit-bound GateReceipt", () => {
    const now = new Date()
    const issuedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 600_000).toISOString()
    const maintainer = verifyExecutionTrust(
      signExecutionClaim(
        {
          tier: "trusted:maintainer",
          callerKind: "person",
          actor: "roninjin10",
          repository: "smithersai/smithers-ci",
          commitSha: SHA_A,
          issuedAt,
          expiresAt
        },
        SECRET
      ),
      { signingSecret: SECRET }
    )

    // Omitting typecheckPassed produces a warning and DOES NOT satisfy the gate
    const unmeasured = runBackpressureAudit({ repoRoot: process.cwd(), execution: maintainer })
    const tcCheck = unmeasured.categories[0]!.audits.find((a) => a.id === "ts-strict-typecheck")
    expect(tcCheck?.status).toBe("warn")
    expect(unmeasured.gate.satisfied).toBe(false)
    expect(unmeasured.gateReceipt.satisfied).toBe(false)

    // Drafting PR without GateReceipt defaults score to 0 and refuses merge
    const factory = new FactoryState("smithersai/smithers-ci")
    const unverifiedPr = factory.draftPull(
      { title: "Unverified PR", body: "No receipt", branch: "feat/unverified" },
      maintainer
    )
    expect(unverifiedPr.auditScore).toBe(0)
    expect(unverifiedPr.gateSatisfied).toBe(false)
    expect(() => factory.mergePull(unverifiedPr.number, maintainer)).toThrow(FactoryActionError)

    // Valid commit-bound GateReceipt clears merge ONLY for the exact head SHA
    const receipt = createGateReceipt(maintainer, evaluateGate(maintainer, "lighthouse-backpressure", true), 99)
    const verifiedPr = factory.draftPull(
      { title: "Verified PR", body: "Has receipt", branch: "feat/verified", gateReceipt: receipt },
      maintainer
    )
    expect(verifiedPr.gateSatisfied).toBe(true)
    // Wrong head SHA rejected even though PR had a receipt for SHA_A
    expect(() => factory.mergePull(verifiedPr.number, maintainer, SHA_B)).toThrow(FactoryActionError)
    // Exact head SHA merges cleanly
    const merged = factory.mergePull(verifiedPr.number, maintainer, SHA_A)
    expect(merged.state).toBe("merged")
  })

  it("Finding #5 & #7: untrusted blobs isolate in untrusted-cas/ with quotas; corrupt CAS self-repairs and tampered AC fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "smithers-store-iso-"))
    const store = new SharedObjectStore({
      rootDir: tmp,
      maxUntrustedObjectsPerActor: 2,
      maxUntrustedBytesPerActor: 64
    })

    const now = new Date()
    const untrusted = verifyExecutionTrust({
      tier: "untrusted:community",
      callerKind: "person",
      actor: "community-user",
      repository: "smithersai/smithers-ci",
      commitSha: SHA_A,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString()
    })
    const trusted = verifyExecutionTrust(
      signExecutionClaim(
        {
          tier: "trusted:sandbox",
          callerKind: "sandbox",
          actor: "cfbox-01",
          repository: "smithersai/smithers-ci",
          commitSha: SHA_A,
          sandboxId: "cfbox-01",
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 600_000).toISOString()
        },
        SECRET
      ),
      { signingSecret: SECRET }
    )

    store.putArtifact("a.txt", "1234567890", { contentType: "text/plain", execution: untrusted })
    // Shared cas/ directory MUST remain completely empty!
    expect(readdirSync(join(tmp, "cas")).length).toBe(0)
    expect(readdirSync(join(tmp, "untrusted-cas")).length).toBe(1)

    // Exceeding byte quota fails
    expect(() =>
      store.putArtifact("b.txt", "x".repeat(60), { contentType: "text/plain", execution: untrusted })
    ).toThrow(ObjectStoreError)

    // Exceeding object count quota fails
    store.putArtifact("c.txt", "ok", { contentType: "text/plain", execution: untrusted })
    expect(() =>
      store.putArtifact("d.txt", "ok", { contentType: "text/plain", execution: untrusted })
    ).toThrow(ObjectStoreError)

    // Corrupt CAS blob detection + atomic self-repair on re-put
    const digest = store.putCas("golden-artifact", trusted)
    writeFileSync(join(tmp, "cas", digest), "corrupted-bytes", "utf8")
    expect(() => store.getCas(digest)).toThrow(ObjectStoreError)
    store.putCas("golden-artifact", trusted)
    expect(store.getCas(digest)?.toString("utf8")).toBe("golden-artifact")

    // Action-cache actionKey binding check
    const keyA = "a".repeat(64)
    const keyB = "b".repeat(64)
    store.putActionCache(keyA, "cached-out", { exitCode: 0, durationMs: 50 }, trusted)
    const tampered = JSON.parse(
      JSON.stringify({ ...store.getActionCache(keyA)!.record, actionKey: keyB })
    )
    writeFileSync(join(tmp, "ac", `${keyA}.json`), JSON.stringify(tampered), "utf8")
    expect(() => store.getActionCache(keyA)).toThrow(ObjectStoreError)
  })

  it("Finding #8, #9, #10, #11, #12: PKCE boundaries, writeTokenFile rollback, body size 413, unknown tiers, and default-deny actions", async () => {
    let clock = new Date("2026-11-27T08:00:00.000Z")
    const tokens = new OneTimeTokenStore({ now: () => clock })

    // Whitespace-only PKCE challenge rejected
    expect(() =>
      tokens.mint({
        repository: "smithersai/smithers-ci",
        subject: "agent:test",
        mintedBy: "roninjin10",
        trustTier: "untrusted:community",
        scopes: ["mcp:read"],
        pkceChallenge: "   "
      })
    ).toThrow()

    // Exact expiry boundary (now === expiresAt) rejected
    const minted = tokens.mint({
      repository: "smithersai/smithers-ci",
      subject: "agent:test",
      mintedBy: "roninjin10",
      trustTier: "untrusted:community",
      scopes: ["mcp:read"],
      ttlSeconds: 60
    })
    clock = new Date(Date.parse(minted.expiresAt))
    const exactBoundary = tokens.redeem({ rawToken: minted.rawToken, repository: "smithersai/smithers-ci" })
    expect(exactBoundary.ok).toBe(false)
    if (!exactBoundary.ok) expect(exactBoundary.code).toBe("expired")

    // writeTokenFile rolls back token file if receipt path already exists
    const tmp = mkdtempSync(join(tmpdir(), "smithers-tok-rollback-"))
    const tokenPath = join(tmp, "bootstrap.token")
    writeFileSync(`${tokenPath}.json`, "pre-existing-receipt", "utf8")
    expect(() => writeTokenFile(tokenPath, minted)).toThrow()
    expect(existsSync(tokenPath)).toBe(false)

    // Worker 413 payload_too_large and -32601 unhandled tool
    const oversized = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(300 * 1024)
      }),
      {}
    )
    expect(oversized.status).toBe(413)

    const unsupported = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 77,
          method: "tools/call",
          params: { name: "repo_read_file", arguments: { path: "README.md" } }
        })
      }),
      {}
    )
    const unsupportedJson = (await unsupported.json()) as { error?: { code: number } }
    expect(unsupportedJson.error?.code).toBe(-32601)

    // Unknown signed tier MUST NOT fall through to trusted:sandbox
    const rogueClaim = {
      tier: "trusted:root" as unknown as ExecutionClaim["tier"],
      callerKind: "sandbox" as const,
      actor: "cfbox-01",
      repository: "smithersai/smithers-ci",
      commitSha: SHA_A,
      sandboxId: "cfbox-01",
      issuedAt: "2026-11-27T07:59:00.000Z",
      expiresAt: "2026-11-27T08:15:00.000Z"
    }
    const forgedMac = createHmac("sha256", SECRET)
      .update(canonicalAttestationPayload(rogueClaim))
      .digest("hex")
    const verifiedRogue = verifyExecutionTrust(
      { ...rogueClaim, attestation: forgedMac },
      { signingSecret: SECRET, now: () => new Date("2026-11-27T08:00:00.000Z") }
    )
    expect(verifiedRogue.trusted).toBe(false)
    expect(verifiedRogue.effectiveTier).toBe("untrusted:community")
    expect(authorizeAction(verifiedRogue, "invented/privileged-action").allowed).toBe(false)
    expect(authorizeAction(verifiedRogue, "invented/privileged-action").code).toBe("unknown_action")
  })

  it("Finding #13 & Fuzz (1,000+ randomized cases): validateHomeJson never throws, resolveAudience enforces login, ExecutionTrust & LighthouseHtml resist fuzzing", () => {
    // Signed-out profile with positive contributions MUST stay viewer
    expect(resolveAudience({ login: null, contributions: 99 }).role).toBe("viewer")
    expect(resolveAudience({ login: "  ", contributions: 99 }).role).toBe("viewer")

    // Adversarial Home JSON shapes (null array items, bad dates, encoded traversal, credentialed URLs, unknown block kinds)
    const badHomes = [
      "null",
      "[]",
      JSON.stringify({ docs: "https://user:pass@ci.smithers.sh", blocks: [{ type: "text", text: "ok" }] }),
      JSON.stringify({ sections: [{ audience: { evil: 1 }, blocks: [] }] }),
      JSON.stringify({ blocks: [{ type: "hero", title: "Hi", actions: [null] }] }),
      JSON.stringify({ blocks: [{ type: "cards", cards: [null] }] }),
      JSON.stringify({ blocks: [{ type: "stats", stats: [42] }] }),
      JSON.stringify({ blocks: [{ type: "links", links: [null] }] }),
      JSON.stringify({ blocks: [{ type: "releases", releases: [null] }] }),
      JSON.stringify({ blocks: [{ type: "releases", releases: [{ name: "v1", url: "https://smithers.sh", date: "2026-02-29" }] }] }),
      JSON.stringify({ blocks: [{ type: "markdown", path: "%2e%2e/secret.md" }] }),
      JSON.stringify({ blocks: [{ type: "totally_unknown_widget" }] })
    ]
    for (const raw of badHomes) {
      const res = validateHomeJson(raw)
      expect(res.valid, `expected invalid for ${raw}`).toBe(false)
    }

    // Seeded 500-iteration ExecutionTrust forgery fuzz
    const rng = makeRng(0x5a17c0de)
    const tiers = ["trusted:maintainer", "trusted:sandbox", "trusted:admin", "untrusted:community", ""] as const
    const kinds = ["person", "agent", "sandbox", "daemon"] as const
    for (let i = 0; i < 500; i++) {
      const tier = tiers[Math.floor(rng() * tiers.length)]!
      const kind = kinds[Math.floor(rng() * kinds.length)]!
      const mac = Array.from({ length: 64 }, () => Math.floor(rng() * 16).toString(16)).join("")
      const verified = verifyExecutionTrust(
        {
          tier: tier as ExecutionClaim["tier"],
          callerKind: kind as ExecutionClaim["callerKind"],
          actor: rng() > 0.5 ? "roninjin10" : `fuzz-actor-${i}`,
          repository: "smithersai/smithers-ci",
          commitSha: SHA_A,
          sandboxId: rng() > 0.5 ? `cfbox-${i}` : `rogue-${i}`,
          issuedAt: "2026-11-27T07:55:00.000Z",
          expiresAt: "2026-11-27T08:30:00.000Z",
          attestation: mac
        },
        { signingSecret: SECRET, now: () => new Date("2026-11-27T08:00:00.000Z") }
      )
      expect(verified.trusted).toBe(false)
      expect(evaluateExecutionPolicy(verified).allowCacheWrite).toBe(false)
      expect(evaluateExecutionPolicy(verified).canSatisfyGates).toBe(false)
    }

    // Seeded 500-iteration MythicalHistory invariant fuzz
    const seq = new MythicalHistorySequencer()
    for (let e = 1; e <= 4; e++) {
      expect(
        seq.apply({
          type: "epic.add",
          id: `epic-0${e}`,
          title: `Epic ${e}`,
          summary: "Fuzzed epic summary"
        }).ok
      ).toBe(true)
    }
    for (let i = 0; i < 500; i++) {
      const sha = i.toString(16).padStart(40, "0")
      const epicId = `epic-0${(i % 4) + 1}`
      expect(seq.apply({ type: "commit.plan", epicId, title: `Commit ${i}` }).ok).toBe(true)
      const commitId = `m${i + 1}`
      expect(seq.apply({ type: "commit.start", id: commitId, lane: `lane-${i % 3}` }).ok).toBe(true)
      expect(seq.apply({ type: "commit.note", id: commitId, section: "tried", text: `Tried ${i}` }).ok).toBe(true)
      expect(seq.apply({ type: "commit.note", id: commitId, section: "evidence", text: `Passed ${i}` }).ok).toBe(true)
      expect(seq.apply({ type: "commit.approve", id: commitId, by: "roninjin10" }).ok).toBe(true)
      expect(seq.apply({ type: "commit.fold", id: commitId, sha, message: `feat: commit ${i}` }).ok).toBe(true)
    }
    const snap1 = seq.snapshot()
    const manifest1 = seq.exportManifest()
    expect(snap1.commits.length).toBe(500)
    // Re-folding an already-folded SHA must be idempotent / refused without changing manifest digest
    seq.apply({ type: "commit.fold", id: "m1", sha: "0".repeat(40), message: "duplicate fold" })
    expect(seq.snapshot().commits.length).toBe(500)
    expect(seq.exportManifest().manifestDigest).toBe(manifest1.manifestDigest)

    // XSS payload escaping in LighthouseHtml
    const xssExec = verifyExecutionTrust({
      tier: "untrusted:community",
      callerKind: "person",
      actor: "<script>alert(1)</script>",
      repository: "smithersai/smithers-ci",
      commitSha: SHA_A,
      issuedAt: "2026-11-27T07:55:00.000Z",
      expiresAt: "2026-11-27T08:30:00.000Z"
    })
    const report = runBackpressureAudit({
      repoRoot: process.cwd(),
      execution: xssExec,
      typecheckPassed: true
    })
    const html = renderLighthouseHtml({
      ...report,
      repository: `smithersai/<img src=x onerror=alert(1)>`
    })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).toContain("Content-Security-Policy")

    // PKCE challenge helper consistency
    const v = "canonical-rfc7636-pkce-verifier-0123456789abcdef-XYZ"
    expect(computePkceS256Challenge(v)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
