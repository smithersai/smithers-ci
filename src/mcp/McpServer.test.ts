import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { OneTimeTokenStore } from "../auth/OneTimeToken.ts"
import { FactoryState } from "../factory/FactoryState.ts"
import { MythicalHistorySequencer } from "../history/MythicalHistory.ts"
import { SharedObjectStore } from "../store/ObjectStore.ts"
import { SmithersCloudMcpServer } from "./McpServer.ts"

describe("SmithersCloudMcpServer", () => {
  it("supports public reads, one-time token exchange, scoped agent writes, and blocks person-only actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-mcp-"))
    const store = new SharedObjectStore({ rootDir: join(dir, "store") })
    const tokens = new OneTimeTokenStore({ baseUrl: "https://smithers.sh" })
    const factory = new FactoryState("smithersai/smithers-ci")
    const history = new MythicalHistorySequencer()

    const server = new SmithersCloudMcpServer({
      repoRoot: process.cwd(),
      repository: "smithersai/smithers-ci",
      baseUrl: "https://smithers.sh",
      commitSha: "46412bca49c3a0f1234567890abcdef123456789",
      store,
      tokens,
      factory,
      history
    })

    // Initialize + tools/list work publicly
    const init = server.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" })
    expect(init.error).toBeUndefined()

    const list = server.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = (list.result as { tools: Array<{ name: string }> }).tools
    expect(tools.length).toBeGreaterThanOrEqual(18)

    // Anonymous write refused
    const unauthWrite = server.handleRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "todo_draft", arguments: { title: "Unauthorized", body: "Nope" } }
    })
    expect(unauthWrite.error?.code).toBe(-32002)

    // Person-only action always refused -32003
    const personOnly = server.handleRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "pr/merge", arguments: { number: 101 } }
    })
    expect(personOnly.error?.code).toBe(-32003)

    // Mint & redeem one-time untrusted community token -> can draft TODO & upload untrusted artifact, cannot satisfy gates
    const minted = tokens.mint({
      repository: "smithersai/smithers-ci",
      subject: "agent:community-bot",
      mintedBy: "alice-dev",
      trustTier: "untrusted:community",
      scopes: ["mcp:read", "todo:draft", "artifact:write:untrusted", "cache:write", "pr/merge"]
    })
    expect(minted.strippedScopes).toEqual(["cache:write", "pr/merge"])

    const redeemed = tokens.redeem({ rawToken: minted.rawToken, repository: "smithersai/smithers-ci" })
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) throw new Error("expected redeem")

    const authHeader = `Bearer ${redeemed.lease.rawLeaseToken}`
    const draftRes = server.handleRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "todo_draft",
          arguments: { title: "Community replay check", body: "Created over Cloud MCP" }
        }
      },
      authHeader
    )
    expect(draftRes.error).toBeUndefined()

    const artifactRes = server.handleRpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "artifact_put",
          arguments: { name: "community-note.txt", content: "hello from untrusted agent" }
        }
      },
      authHeader
    )
    expect(artifactRes.error).toBeUndefined()
    const uploaded = (artifactRes.result as { structuredContent: { artifact: { key: string; trusted: boolean } } })
      .structuredContent.artifact
    expect(uploaded.trusted).toBe(false)
    expect(uploaded.key).toContain("untrusted/community-bot/")
  })
})
