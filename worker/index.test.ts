import { describe, expect, it } from "vitest"
import worker from "./index.ts"

describe("Cloudflare Worker (Factory UI + Cloud MCP)", () => {
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
