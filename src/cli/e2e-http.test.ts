import { describe, expect, it } from "vitest"
import { computePkceS256Challenge } from "../auth/OneTimeToken.ts"
import { startLocalMcpHttpServer } from "./main.ts"

describe("Local Streamable HTTP Cloud MCP E2E", () => {
  it("runs discovery, PKCE S256 one-time exchange, replay block, scoped MCP writes, person-only block, and 413 cap over live loopback HTTP", async () => {
    const srv = await startLocalMcpHttpServer({
      repoRoot: process.cwd(),
      port: 0
    })

    try {
      // 1. OAuth discovery metadata matches actual implemented endpoints
      const resMeta = await fetch(`${srv.baseUrl}/.well-known/oauth-authorization-server`)
      expect(resMeta.status).toBe(200)
      const meta = (await resMeta.json()) as {
        token_endpoint: string
        one_time_exchange_endpoint: string
        code_challenge_methods_supported: string[]
      }
      expect(meta.token_endpoint).toBe(`${srv.baseUrl}/smithersai/smithers-ci/mcp/exchange`)
      expect(meta.one_time_exchange_endpoint).toBe(meta.token_endpoint)
      expect(meta.code_challenge_methods_supported).toContain("S256")

      // 2. Public MCP tools/list works anonymously
      const listRes = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      })
      expect(listRes.status).toBe(200)
      const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
      expect(listJson.result.tools.length).toBe(20)

      // 3. Mint PKCE S256 token on live server's OneTimeTokenStore and exchange over HTTP
      const verifier = "live-http-e2e-pkce-verifier-0123456789abcdef0123456789"
      const challenge = computePkceS256Challenge(verifier)
      const minted = srv.tokens.mint({
        repository: "smithersai/smithers-ci",
        subject: "sandbox:cfbox-http-e2e",
        mintedBy: "roninjin10",
        trustTier: "trusted:sandbox",
        sandboxId: "cfbox-http-e2e",
        scopes: ["mcp:read", "todo:draft", "artifact:write:trusted", "pr/merge"],
        pkceChallenge: challenge
      })
      expect(minted.strippedScopes).toContain("pr/merge")

      // Wrong verifier fails 401
      const badExch = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: minted.rawToken, pkceVerifier: "wrong-verifier-0123456789abcdef0123456789abcdef" })
      })
      expect(badExch.status).toBe(401)

      // Correct verifier succeeds 200 and burns token
      const okExch = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: minted.rawToken, pkceVerifier: verifier })
      })
      expect(okExch.status).toBe(200)
      const lease = (await okExch.json()) as { leaseToken: string; trustTier: string }
      expect(lease.leaseToken).toMatch(/^sms_[0-9a-f]{64}$/)

      // Replay fails 401 already_redeemed
      const replayExch = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: minted.rawToken, pkceVerifier: verifier })
      })
      expect(replayExch.status).toBe(401)
      const replayJson = (await replayExch.json()) as { code: string }
      expect(replayJson.code).toBe("already_redeemed")

      // 4. Authenticated MCP call drafts TODO and blocks pr/merge (-32003)
      const draftRes = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${lease.leaseToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "todo_draft", arguments: { title: "Live HTTP E2E TODO", body: "Verified over loopback" } }
        })
      })
      expect(draftRes.status).toBe(200)
      const draftJson = (await draftRes.json()) as { result: { structuredContent: { todo: { title: string } } } }
      expect(draftJson.result.structuredContent.todo.title).toBe("Live HTTP E2E TODO")

      const mergeRes = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${lease.leaseToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "pr/merge", arguments: { number: 101 } }
        })
      })
      const mergeJson = (await mergeRes.json()) as { error: { code: number } }
      expect(mergeJson.error.code).toBe(-32003)

      // 5. Oversized request body returns 413
      const bigRes = await fetch(`${srv.baseUrl}/smithersai/smithers-ci/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "a".repeat(300 * 1024)
      })
      expect(bigRes.status).toBe(413)
    } finally {
      await srv.close()
    }
  })
})
