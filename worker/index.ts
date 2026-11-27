import { FACTORY_SNAPSHOT } from "../app/src/data/generatedSnapshot.ts"
import { FactoryHubDO } from "./FactoryHubDO.ts"

export { FactoryHubDO }

export interface DurableNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

export interface WorkerEnv {
  readonly ASSETS?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
  readonly FACTORY_HUB?: DurableNamespaceLike
  readonly SMITHERS_BASE_URL?: string
  readonly SMITHERS_CONTROL_SECRET?: string
}

const MAX_REQUEST_BODY_BYTES = 256 * 1024 // 256 KiB hard edge cap
const fallbackHub = new FactoryHubDO({ storage: {} })

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  })
}

function getHub(env: WorkerEnv): { fetch(request: Request): Promise<Response> } {
  if (env.FACTORY_HUB) {
    return env.FACTORY_HUB.get(env.FACTORY_HUB.idFromName("smithersai/smithers-ci"))
  }
  return fallbackHub
}

async function readBoundedBody(
  request: Request,
  maxBytes: number
): Promise<{ readonly ok: true; readonly bytes: ArrayBuffer } | { readonly ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false }
  }
  if (!request.body) {
    return { ok: true, bytes: new ArrayBuffer(0) }
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // ignore cancel error
        }
        return { ok: false }
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: merged.buffer }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    const origin = (env.SMITHERS_BASE_URL ?? url.origin).replace(/\/+$/, "")

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        service: "smithers-ci-factory",
        repository: FACTORY_SNAPSHOT.repository,
        lighthouseScore: FACTORY_SNAPSHOT.trustedAudit.overallScore,
        objectStore: FACTORY_SNAPSHOT.objectStoreEndpoint,
        durableObject: Boolean(env.FACTORY_HUB)
      })
    }

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return jsonResponse({
        resource: `${origin}/${FACTORY_SNAPSHOT.repository}/mcp`,
        authorization_servers: [origin],
        scopes_supported: [
          "mcp:read",
          "mcp:write",
          "cache:read",
          "cache:write",
          "artifact:read",
          "artifact:write:trusted",
          "artifact:write:untrusted",
          "todo:draft",
          "issue:create",
          "issue:comment",
          "pr:draft",
          "changeset:propose",
          "audit:run"
        ],
        bearer_methods_supported: ["header"]
      })
    }

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      const exchangeEndpoint = `${origin}/${FACTORY_SNAPSHOT.repository}/mcp/exchange`
      return jsonResponse({
        issuer: origin,
        token_endpoint: exchangeEndpoint,
        one_time_exchange_endpoint: exchangeEndpoint,
        mcp_endpoint: `${origin}/${FACTORY_SNAPSHOT.repository}/mcp`,
        grant_types_supported: ["urn:smithers:params:oauth:grant-type:one-time-token"],
        code_challenge_methods_supported: ["S256"]
      })
    }

    if (request.method === "GET" && url.pathname === "/api/audit.json") {
      return jsonResponse(FACTORY_SNAPSHOT.trustedAudit)
    }

    if (request.method === "GET" && url.pathname === "/api/audit-untrusted.json") {
      return jsonResponse(FACTORY_SNAPSHOT.untrustedAudit)
    }

    // Stateful Durable Object routes: MCP, one-time token mint & exchange, live factory state, waitlist
    if (
      url.pathname === "/mcp" ||
      url.pathname === "/smithersai/smithers-ci/mcp" ||
      url.pathname === "/smithersai/smithers-ci/mcp/exchange" ||
      url.pathname === "/smithersai/smithers-ci/mcp/mint" ||
      url.pathname === "/api/factory" ||
      url.pathname === "/api/waitlist"
    ) {
      // Strip any untrusted caller-spoofed control plane header; only set it if valid bearer control secret matches.
      const forwardedHeaders = new Headers(request.headers)
      forwardedHeaders.delete("x-smithers-control-plane")
      const controlAuth = request.headers.get("x-smithers-control-secret") ?? ""
      if (
        env.SMITHERS_CONTROL_SECRET &&
        env.SMITHERS_CONTROL_SECRET.length >= 16 &&
        constantTimeEqual(controlAuth, env.SMITHERS_CONTROL_SECRET)
      ) {
        forwardedHeaders.set("x-smithers-control-plane", "verified")
      }

      let bodyBytes: ArrayBuffer | undefined
      if (request.method !== "GET" && request.method !== "HEAD") {
        const readRes = await readBoundedBody(request, MAX_REQUEST_BODY_BYTES)
        if (!readRes.ok) {
          return jsonResponse(
            { error: "payload_too_large", message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes` },
            413
          )
        }
        bodyBytes = readRes.bytes
      }

      const forwarded = new Request(request.url, {
        method: request.method,
        headers: forwardedHeaders,
        body: bodyBytes
      })
      return getHub(env).fetch(forwarded)
    }

    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request)
      if (assetRes.status !== 404) {
        return assetRes
      }
      // SPA fallback fetches "/" (never "/index.html") to prevent 307 redirects on deep links.
      return env.ASSETS.fetch(new Request(new URL("/", url.origin), request))
    }

    return jsonResponse({ error: "not_found" }, 404)
  }
}
