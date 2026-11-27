import { FACTORY_SNAPSHOT } from "../app/src/data/generatedSnapshot.ts"

export interface WorkerEnv {
  readonly ASSETS?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
  readonly SMITHERS_BASE_URL?: string
}

const PROTOCOL_VERSION = "2025-11-25"
const PERSON_ONLY = new Set<string>(FACTORY_SNAPSHOT.personOnlyActions)

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  })
}

async function handleMcpRpc(request: Request, origin: string): Promise<Response> {
  let payload: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return jsonResponse(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } },
      400
    )
  }

  const id = payload.id ?? null
  const method = payload.method ?? ""

  if (method === "initialize") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "smithers-ci-cloud-mcp", version: "1.0.0-rc.20" },
        capabilities: { tools: { listChanged: false } },
        instructions:
          "Smithers CI public Cloud MCP server. Public reads work anonymously. Writes require an authenticated bearer lease exchanged from a single-use smo_ token or OAuth 2.1 PKCE S256 grant. Person-only actions are never callable via MCP."
      }
    })
  }

  if (method === "tools/list") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        tools: FACTORY_SNAPSHOT.mcpTools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      }
    })
  }

  if (method === "tools/call") {
    const params = payload.params ?? {}
    const name = typeof params.name === "string" ? params.name : ""
    const args = (params.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {}) as Record<string, unknown>

    if (PERSON_ONLY.has(name)) {
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32003, message: `Action ${name} is person_only and cannot be executed via MCP` }
      })
    }

    const def = FACTORY_SNAPSHOT.mcpTools.find((t) => t.name === name)
    if (!def) {
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown MCP tool: ${name}` }
      })
    }

    if (def.requiredScope !== null) {
      const auth = request.headers.get("authorization") ?? ""
      if (!auth.startsWith("Bearer sms_")) {
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32002,
            message: `Tool ${name} requires authenticated scope ${def.requiredScope}. Exchange a one-time smo_ token at ${origin}/smithersai/smithers-ci/mcp/exchange.`
          }
        })
      }
    }

    let output: unknown
    switch (name) {
      case "audit_run":
        output = { report: FACTORY_SNAPSHOT.trustedAudit }
        break
      case "artifacts_list":
        output = {
          artifacts:
            args.trustedOnly === true
              ? FACTORY_SNAPSHOT.artifacts.filter((a) => a.trusted)
              : FACTORY_SNAPSHOT.artifacts
        }
        break
      case "cache_stats":
        output = { stats: FACTORY_SNAPSHOT.storeStats }
        break
      case "todos_list":
        output = { todos: FACTORY_SNAPSHOT.todos }
        break
      case "issues_list":
        output = { issues: FACTORY_SNAPSHOT.issues }
        break
      case "issue_get": {
        const num = Number(args.number)
        const issue = FACTORY_SNAPSHOT.issues.find((i) => i.number === num)
        if (!issue) {
          return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32000, message: `Issue #${num} not found` } })
        }
        output = { issue }
        break
      }
      case "pulls_list":
        output = { pulls: FACTORY_SNAPSHOT.pulls }
        break
      case "changesets_stack_list":
        output = { changesets: FACTORY_SNAPSHOT.changesets }
        break
      case "wiki_search": {
        const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : ""
        const pages = FACTORY_SNAPSHOT.wiki.pages.filter(
          (p) => !q || p.title.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q) || p.markdown.toLowerCase().includes(q)
        )
        output = { pages: pages.map(({ slug, title, summary, linksOut, backlinks }) => ({ slug, title, summary, linksOut, backlinks })) }
        break
      }
      case "wiki_read": {
        const slug = String(args.slug ?? "").trim().toLowerCase()
        const page = FACTORY_SNAPSHOT.wiki.pages.find((p) => p.slug === slug)
        if (!page) {
          return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32000, message: `Wiki page not found: ${slug}` } })
        }
        output = { page }
        break
      }
      case "mythical_history_outline":
        output = { snapshot: FACTORY_SNAPSHOT.history, manifest: FACTORY_SNAPSHOT.historyManifest }
        break
      case "trust_policy_explain":
        output = {
          personOnlyActions: FACTORY_SNAPSHOT.personOnlyActions,
          rootInputTracing: FACTORY_SNAPSHOT.rootInputTracing
        }
        break
      default:
        output = { ok: true, tool: name, note: "Handled against Smithers Cloud repository state" }
        break
    }

    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      }
    })
  }

  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unsupported MCP method: ${method}` }
  })
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
        objectStore: FACTORY_SNAPSHOT.objectStoreEndpoint
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
          "changeset:propose",
          "audit:run"
        ],
        bearer_methods_supported: ["header"]
      })
    }

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: origin,
        authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
        token_endpoint: `${origin}/api/mcp/oauth/token`,
        registration_endpoint: `${origin}/api/mcp/oauth/register`,
        one_time_exchange_endpoint: `${origin}/${FACTORY_SNAPSHOT.repository}/mcp/exchange`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"]
      })
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/mcp" || url.pathname === "/smithersai/smithers-ci/mcp")
    ) {
      return handleMcpRpc(request, origin)
    }

    if (request.method === "GET" && url.pathname === "/api/audit.json") {
      return jsonResponse(FACTORY_SNAPSHOT.trustedAudit)
    }

    if (request.method === "GET" && url.pathname === "/api/audit-untrusted.json") {
      return jsonResponse(FACTORY_SNAPSHOT.untrustedAudit)
    }

    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request)
      if (assetRes.status !== 404) {
        return assetRes
      }
      // SPA fallback fetches "/" (never "/index.html") to avoid 307 redirects on deep links.
      return env.ASSETS.fetch(new Request(new URL("/", url.origin), request))
    }

    return jsonResponse({ error: "not_found" }, 404)
  }
}
