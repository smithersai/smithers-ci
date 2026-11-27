import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { runBackpressureAudit } from "../audit/AuditEngine.ts"
import { renderLighthouseHtml } from "../audit/LighthouseHtml.ts"
import { OneTimeTokenStore, type SessionLease, type TokenScope } from "../auth/OneTimeToken.ts"
import { FactoryActionError, FactoryState } from "../factory/FactoryState.ts"
import { MythicalHistorySequencer } from "../history/MythicalHistory.ts"
import { SharedObjectStore } from "../store/ObjectStore.ts"
import {
  PERSON_ONLY_ACTIONS,
  ROOT_INPUT_TRACING_TABLE,
  type VerifiedExecution,
  evaluateExecutionPolicy
} from "../trust/ExecutionTrust.ts"
import { loadWikiGraph, searchWiki } from "../wiki/WikiEngine.ts"

export const MCP_PROTOCOL_VERSION = "2025-11-25"

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly requiredScope: TokenScope | null
  readonly inputSchema: Record<string, unknown>
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export interface McpServerContext {
  readonly repoRoot: string
  readonly repository: string
  readonly baseUrl: string
  readonly commitSha: string
  readonly store: SharedObjectStore
  readonly tokens: OneTimeTokenStore
  readonly factory: FactoryState
  readonly history: MythicalHistorySequencer
}

export const MCP_TOOLS: ReadonlyArray<McpToolDefinition> = [
  {
    name: "repo_tree",
    description: "List repository file paths safely within the repository root.",
    requiredScope: null,
    inputSchema: { type: "object", properties: { prefix: { type: "string" } } }
  },
  {
    name: "repo_read_file",
    description: "Read a UTF-8 file from the repository with strict path containment.",
    requiredScope: null,
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }
  },
  {
    name: "audit_run",
    description: "Run the Lighthouse-style 6-category backpressure audit and upload JSON + HTML reports to the shared object store.",
    requiredScope: null,
    inputSchema: { type: "object", properties: { storeArtifacts: { type: "boolean" } } }
  },
  {
    name: "artifacts_list",
    description: "List artifacts stored in the shared Smithers Cloud object store.",
    requiredScope: null,
    inputSchema: { type: "object", properties: { trustedOnly: { type: "boolean" } } }
  },
  {
    name: "artifact_put",
    description: "Upload a named artifact to the shared object store (trusted namespace for controlled sandboxes/maintainers, isolated untrusted namespace for community).",
    requiredScope: "artifact:write:untrusted",
    inputSchema: {
      type: "object",
      required: ["name", "content"],
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        contentType: { type: "string" },
        visibility: { type: "string", enum: ["public", "private"] }
      }
    }
  },
  {
    name: "cache_stats",
    description: "Inspect shared Smithers Cloud object store (/ac, /cas, artifacts) metrics.",
    requiredScope: null,
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "todos_list",
    description: "List the public repository TODO stack.",
    requiredScope: null,
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "todo_draft",
    description: "Draft a new TODO onto the stack. Committing a TODO remains person-only.",
    requiredScope: "todo:draft",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        priority: { type: "string", enum: ["P0", "P1", "P2"] },
        linkedIssue: { type: "number" }
      }
    }
  },
  {
    name: "issues_list",
    description: "List public repository issues and triage states.",
    requiredScope: null,
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "issue_get",
    description: "Read one repository issue and its comments by number.",
    requiredScope: null,
    inputSchema: { type: "object", required: ["number"], properties: { number: { type: "number" } } }
  },
  {
    name: "issue_create",
    description: "Open a public issue attributed as <actor> (agent). Policy smithers:* labels are stripped.",
    requiredScope: "issue:create",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "issue_comment",
    description: "Add an agent-attributed comment to an existing issue.",
    requiredScope: "issue:comment",
    inputSchema: {
      type: "object",
      required: ["number", "body"],
      properties: { number: { type: "number" }, body: { type: "string" } }
    }
  },
  {
    name: "pulls_list",
    description: "List pull requests with trust tier, Lighthouse audit score, and merge gate status.",
    requiredScope: null,
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "pull_draft",
    description: "Draft a pull request linked to stacked changesets. Merging remains person-only.",
    requiredScope: "pr:draft",
    inputSchema: {
      type: "object",
      required: ["title", "body", "branch"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        branch: { type: "string" },
        baseBranch: { type: "string" },
        changesetIds: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "changesets_stack_list",
    description: "List the repository's linear stack of changesets with parent links and trust status.",
    requiredScope: null,
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "changeset_propose",
    description: "Propose a new stacked changeset onto the repository stack.",
    requiredScope: "changeset:propose",
    inputSchema: {
      type: "object",
      required: ["title", "branch", "diffSummary"],
      properties: {
        title: { type: "string" },
        branch: { type: "string" },
        parentId: { type: "string" },
        diffSummary: { type: "string" }
      }
    }
  },
  {
    name: "wiki_search",
    description: "Search or list the Obsidian-compatible repository wiki pages, links, and backlinks.",
    requiredScope: null,
    inputSchema: { type: "object", properties: { query: { type: "string" } } }
  },
  {
    name: "wiki_read",
    description: "Read a single wiki page by slug along with its outgoing wikilinks and backlinks.",
    requiredScope: null,
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } }
  },
  {
    name: "mythical_history_outline",
    description: "Read the deterministic Mythical History epics, linear commits, folded real SHAs, and notes.",
    requiredScope: null,
    inputSchema: { type: "object", properties: { query: { type: "string" } } }
  },
  {
    name: "trust_policy_explain",
    description: "Explain the caller's verified trust tier, cache/gate capabilities, and root-input-tracing boundaries.",
    requiredScope: null,
    inputSchema: { type: "object", properties: {} }
  }
]

function walkRepoFiles(root: string, current: string, out: string[], limit = 300): void {
  if (out.length >= limit) return
  const entries = readdirSync(current).sort()
  for (const name of entries) {
    if (out.length >= limit) return
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === ".jj" ||
      name === "dist" ||
      name === ".smithers/object-store"
    ) {
      continue
    }
    const full = join(current, name)
    const rel = relative(root, full)
    if (rel.startsWith(".smithers/object-store") || rel.startsWith(".smithers/tokens")) continue
    const st = statSync(full)
    if (st.isDirectory()) {
      walkRepoFiles(root, full, out, limit)
    } else {
      out.push(rel)
    }
  }
}

function executionFromLease(lease: SessionLease | null, ctx: McpServerContext): VerifiedExecution {
  if (!lease) {
    return {
      effectiveTier: "untrusted:community",
      claimedTier: "untrusted:community",
      callerKind: "agent",
      actor: "public-agent",
      repository: ctx.repository,
      commitSha: ctx.commitSha,
      sandboxId: null,
      trusted: false,
      downgraded: false,
      downgradeReason: null,
      verifiedAt: new Date().toISOString()
    }
  }

  return {
    effectiveTier: lease.trustTier,
    claimedTier: lease.trustTier,
    callerKind: lease.sandboxId ? "sandbox" : "agent",
    actor: lease.subject.replace(/^(?:agent|sandbox):/, ""),
    repository: lease.repository,
    commitSha: lease.commitSha ?? ctx.commitSha,
    sandboxId: lease.sandboxId,
    trusted: lease.trustTier !== "untrusted:community",
    downgraded: false,
    downgradeReason: null,
    verifiedAt: new Date().toISOString()
  }
}

function hasRequiredScope(lease: SessionLease | null, required: TokenScope | null): boolean {
  if (required === null) return true
  if (!lease) return false
  if (lease.scopes.includes(required)) return true
  // Trusted artifact write subsumes untrusted artifact write.
  if (required === "artifact:write:untrusted" && lease.scopes.includes("artifact:write:trusted")) {
    return true
  }
  return false
}

export class SmithersCloudMcpServer {
  private readonly ctx: McpServerContext

  constructor(ctx: McpServerContext) {
    this.ctx = ctx
  }

  oauthProtectedResourceMetadata() {
    const resource = `${this.ctx.baseUrl}/${this.ctx.repository}/mcp`
    return {
      resource,
      authorization_servers: [this.ctx.baseUrl],
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
    }
  }

  oauthAuthorizationServerMetadata() {
    return {
      issuer: this.ctx.baseUrl,
      authorization_endpoint: `${this.ctx.baseUrl}/api/mcp/oauth/authorize`,
      token_endpoint: `${this.ctx.baseUrl}/api/mcp/oauth/token`,
      registration_endpoint: `${this.ctx.baseUrl}/api/mcp/oauth/register`,
      one_time_exchange_endpoint: `${this.ctx.baseUrl}/${this.ctx.repository}/mcp/exchange`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"]
    }
  }

  handleRpc(request: JsonRpcRequest, authorizationHeader?: string | null): JsonRpcResponse {
    const id = request.id ?? null

    let lease: SessionLease | null = null
    if (authorizationHeader && authorizationHeader.startsWith("Bearer ")) {
      const token = authorizationHeader.slice("Bearer ".length).trim()
      lease = this.ctx.tokens.verifyLease(token, this.ctx.repository)
      if (!lease) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "Invalid, expired, or revoked MCP bearer lease token"
          }
        }
      }
    }

    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: "smithers-ci-cloud-mcp",
            version: "1.0.0-rc.20"
          },
          capabilities: {
            tools: { listChanged: false }
          },
          instructions:
            "Smithers CI Cloud MCP server. Public reads work anonymously. Write actions require a scoped lease redeemed from a one-time smo_ token or OAuth 2.1 PKCE grant. Person-only actions (pr/merge, todo/commit, release/publish, secrets/write) are never callable by agents."
        }
      }
    }

    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema
          }))
        }
      }
    }

    if (request.method === "tools/call") {
      const params = request.params ?? {}
      const toolName = typeof params.name === "string" ? params.name : ""
      const args = (params.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {}) as Record<string, unknown>

      if ((PERSON_ONLY_ACTIONS as ReadonlyArray<string>).includes(toolName)) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32003,
            message: `Action ${toolName} is person_only and cannot be executed via MCP`
          }
        }
      }

      const def = MCP_TOOLS.find((t) => t.name === toolName)
      if (!def) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown MCP tool: ${toolName}` }
        }
      }

      if (!hasRequiredScope(lease, def.requiredScope)) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32002,
            message: `Tool ${toolName} requires authenticated scope ${def.requiredScope}`
          }
        }
      }

      const execution = executionFromLease(lease, this.ctx)
      try {
        const output = this.executeTool(toolName, args, execution)
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = err instanceof FactoryActionError && err.code === "person_only" ? -32003 : -32000
        return {
          jsonrpc: "2.0",
          id,
          error: { code, message }
        }
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported MCP method: ${request.method}` }
    }
  }

  private executeTool(
    name: string,
    args: Record<string, unknown>,
    execution: VerifiedExecution
  ): unknown {
    switch (name) {
      case "repo_tree": {
        const paths: string[] = []
        walkRepoFiles(this.ctx.repoRoot, this.ctx.repoRoot, paths)
        const prefix = typeof args.prefix === "string" ? args.prefix : ""
        const filtered = prefix ? paths.filter((p) => p.startsWith(prefix)) : paths
        return { repository: this.ctx.repository, ref: this.ctx.commitSha, paths: filtered }
      }
      case "repo_read_file": {
        const relPath = String(args.path ?? "")
        const resolvedRoot = resolve(this.ctx.repoRoot)
        const target = resolve(resolvedRoot, relPath)
        if (!target.startsWith(`${resolvedRoot}/`) || relPath.includes("..")) {
          throw new Error("Path escapes repository root")
        }
        if (!existsSync(target) || statSync(target).isDirectory()) {
          throw new Error(`File not found: ${relPath}`)
        }
        const content = readFileSync(target, "utf8")
        return { path: relPath, bytes: Buffer.byteLength(content, "utf8"), content }
      }
      case "audit_run": {
        const report = runBackpressureAudit({
          repoRoot: this.ctx.repoRoot,
          execution
        })
        let stored: { jsonKey: string; htmlKey: string } | null = null
        if (args.storeArtifacts !== false) {
          const jsonMeta = this.ctx.store.putArtifact("lighthouse-audit.json", JSON.stringify(report, null, 2), {
            contentType: "application/json",
            visibility: "public",
            execution
          })
          const htmlMeta = this.ctx.store.putArtifact("lighthouse-audit.html", renderLighthouseHtml(report), {
            contentType: "text/html; charset=utf-8",
            visibility: "public",
            execution
          })
          stored = { jsonKey: jsonMeta.key, htmlKey: htmlMeta.key }
        }
        return { report, stored }
      }
      case "artifacts_list": {
        const trustedOnly = args.trustedOnly === true
        return { artifacts: this.ctx.store.listArtifacts({ trustedOnly }) }
      }
      case "artifact_put": {
        const artifactName = String(args.name ?? "")
        const content = String(args.content ?? "")
        const contentType = typeof args.contentType === "string" ? args.contentType : "text/plain; charset=utf-8"
        const visibility = args.visibility === "private" ? "private" : "public"
        const meta = this.ctx.store.putArtifact(artifactName, content, {
          contentType,
          visibility,
          execution
        })
        return { artifact: meta }
      }
      case "cache_stats": {
        return { stats: this.ctx.store.stats() }
      }
      case "todos_list": {
        return { todos: this.ctx.factory.listTodos() }
      }
      case "todo_draft": {
        const todo = this.ctx.factory.draftTodo(
          {
            title: String(args.title ?? ""),
            body: String(args.body ?? ""),
            priority: args.priority === "P0" || args.priority === "P2" ? args.priority : "P1",
            linkedIssue: typeof args.linkedIssue === "number" ? args.linkedIssue : null
          },
          execution
        )
        return { todo }
      }
      case "issues_list": {
        return { issues: this.ctx.factory.listIssues() }
      }
      case "issue_get": {
        const issue = this.ctx.factory.getIssue(Number(args.number))
        if (!issue) throw new Error(`Issue #${String(args.number)} not found`)
        return { issue }
      }
      case "issue_create": {
        const labels = Array.isArray(args.labels)
          ? args.labels.filter((l): l is string => typeof l === "string")
          : []
        const issue = this.ctx.factory.createIssue(
          { title: String(args.title ?? ""), body: String(args.body ?? ""), labels },
          execution
        )
        return { issue }
      }
      case "issue_comment": {
        const issue = this.ctx.factory.commentIssue(Number(args.number), String(args.body ?? ""), execution)
        return { issue }
      }
      case "pulls_list": {
        return { pulls: this.ctx.factory.listPulls() }
      }
      case "pull_draft": {
        const changesetIds = Array.isArray(args.changesetIds)
          ? args.changesetIds.filter((c): c is string => typeof c === "string")
          : []
        const pull = this.ctx.factory.draftPull(
          {
            title: String(args.title ?? ""),
            body: String(args.body ?? ""),
            branch: String(args.branch ?? ""),
            baseBranch: typeof args.baseBranch === "string" ? args.baseBranch : "main",
            changesetIds
          },
          execution
        )
        return { pull }
      }
      case "changesets_stack_list": {
        return { changesets: this.ctx.factory.listChangesets() }
      }
      case "changeset_propose": {
        const changeset = this.ctx.factory.proposeChangeset(
          {
            title: String(args.title ?? ""),
            branch: String(args.branch ?? ""),
            parentId: typeof args.parentId === "string" ? args.parentId : null,
            diffSummary: String(args.diffSummary ?? "")
          },
          execution
        )
        return { changeset }
      }
      case "wiki_search": {
        const graph = loadWikiGraph(join(this.ctx.repoRoot, "wiki"))
        const query = typeof args.query === "string" ? args.query : ""
        const hits = searchWiki(graph, query).map((p) => ({
          slug: p.slug,
          title: p.title,
          summary: p.summary,
          linksOut: p.linksOut,
          backlinks: p.backlinks
        }))
        return { pages: hits, brokenLinks: graph.brokenLinks, digest: graph.digest }
      }
      case "wiki_read": {
        const slug = String(args.slug ?? "").trim().toLowerCase()
        const graph = loadWikiGraph(join(this.ctx.repoRoot, "wiki"))
        const page = graph.pages.find((p) => p.slug === slug)
        if (!page) throw new Error(`Wiki page not found: ${slug}`)
        return { page }
      }
      case "mythical_history_outline": {
        const query = typeof args.query === "string" ? args.query : ""
        return {
          snapshot: this.ctx.history.snapshot(),
          matches: query ? this.ctx.history.search(query) : undefined,
          manifest: this.ctx.history.exportManifest()
        }
      }
      case "trust_policy_explain": {
        return {
          execution,
          capabilities: evaluateExecutionPolicy(execution),
          personOnlyActions: PERSON_ONLY_ACTIONS,
          rootInputTracing: ROOT_INPUT_TRACING_TABLE
        }
      }
      default:
        throw new Error(`Unhandled MCP tool: ${name}`)
    }
  }
}
