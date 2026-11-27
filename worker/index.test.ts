import { describe, expect, it } from "vitest"
import { webPkceS256 } from "./FactoryHubDO.ts"
import worker from "./index.ts"

describe("Cloudflare Worker + FactoryHubDO (Factory UI + Live Cloud MCP + One-Time Auth)", () => {
  it("serves health, OAuth 2.1 discovery, public MCP tools, and blocks person-only actions", async () => {
    const health = await worker.fetch(new Request("https://smithers.sh/api/health"), {})
    expect(health.status).toBe(200)
    const healthJson = (await health.json()) as { ok: boolean; lighthouseScore: number }
    expect(healthJson.ok).toBe(true)
    expect(healthJson.lighthouseScore).toBeGreaterThanOrEqual(90)

    const oauth = await worker.fetch(
      new Request("https://smithers.sh/.well-known/oauth-authorization-server"),
      {}
    )
    expect(oauth.status).toBe(200)
    const oauthJson = (await oauth.json()) as { code_challenge_methods_supported: string[] }
    expect(oauthJson.code_challenge_methods_supported).toContain("S256")

    const toolsRes = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      }),
      {}
    )
    expect(toolsRes.status).toBe(200)
    const toolsJson = (await toolsRes.json()) as { result: { tools: Array<{ name: string }> } }
    expect(toolsJson.result.tools.length).toBeGreaterThanOrEqual(18)

    const mergeRes = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "pr/merge", arguments: { number: 101 } }
        })
      }),
      {}
    )
    const mergeJson = (await mergeRes.json()) as { error: { code: number } }
    expect(mergeJson.error.code).toBe(-32003)
  })

  it("mints single-use smo_ token, strips spoofed headers, burns on first PKCE exchange, and persists live MCP writes", async () => {
    const verifier = "worker-pkce-verifier-0123456789abcdef0123456789ab"
    const challenge = await webPkceS256(verifier)

    // Public caller attempting to spoof x-smithers-control-plane header gets downgraded to untrusted:community
    const mintRes = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp/mint", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-smithers-control-plane": "verified"
        },
        body: JSON.stringify({
          subject: "agent:spoof-attempt",
          trustTier: "trusted:sandbox",
          scopes: ["mcp:read", "cache:write", "todo:draft", "artifact:write:untrusted", "pr/merge"],
          pkceChallenge: challenge
        })
      }),
      {}
    )
    expect(mintRes.status).toBe(201)
    const minted = (await mintRes.json()) as {
      token: string
      trustTier: string
      scopes: string[]
      strippedScopes: string[]
    }
    expect(minted.trustTier).toBe("untrusted:community")
    expect(minted.strippedScopes).toContain("cache:write")
    expect(minted.strippedScopes).toContain("pr/merge")

    // Redeem with correct PKCE verifier
    const exch1 = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: minted.token, pkceVerifier: verifier })
      }),
      {}
    )
    expect(exch1.status).toBe(200)
    const lease = (await exch1.json()) as { leaseToken: string; trustTier: string }
    expect(lease.leaseToken).toMatch(/^sms_[0-9a-f]{64}$/)

    // Second exchange MUST fail (single-use burn!)
    const exch2 = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: minted.token, pkceVerifier: verifier })
      }),
      {}
    )
    expect(exch2.status).toBe(401)
    const replayErr = (await exch2.json()) as { code: string }
    expect(replayErr.code).toBe("already_redeemed")

    // Use live lease to draft TODO & upload untrusted artifact
    const draftRes = await worker.fetch(
      new Request("https://smithers.sh/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${lease.leaseToken}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "todo_draft",
            arguments: { title: "Live DO drafted TODO", body: "Persisted via Worker DO" }
          }
        })
      }),
      {}
    )
    expect(draftRes.status).toBe(200)
    const draftJson = (await draftRes.json()) as { result: { structuredContent: { todo: { title: string } } } }
    expect(draftJson.result.structuredContent.todo.title).toBe("Live DO drafted TODO")
  })

  it("falls back SPA deep links to '/' instead of '/index.html' to avoid 307 redirects", async () => {
    const requestedPaths: string[] = []
    const res = await worker.fetch(new Request("https://smithers.sh/smithersai/smithers-ci/audit"), {
      ASSETS: {
        async fetch(input) {
          const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
          requestedPaths.push(u.pathname)
          if (u.pathname === "/") {
            return new Response("<!doctype html><html></html>", { status: 200 })
          }
          return new Response("Not Found", { status: 404 })
        }
      }
    })
    expect(res.status).toBe(200)
    expect(requestedPaths).toEqual(["/smithersai/smithers-ci/audit", "/"])
  })
})
