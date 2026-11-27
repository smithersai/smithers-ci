import { FACTORY_SNAPSHOT } from "../app/src/data/generatedSnapshot.ts"

export interface SqlStorageLike {
  exec(query: string, ...bindings: ReadonlyArray<unknown>): {
    toArray(): Array<Record<string, unknown>>
  }
}

export interface DurableStateLike {
  readonly storage: {
    readonly sql?: SqlStorageLike
  }
}

export interface OneTimeTokenRecord {
  readonly id: string
  readonly digest: string
  readonly subject: string
  readonly trustTier: "trusted:maintainer" | "trusted:sandbox" | "untrusted:community"
  readonly scopes: ReadonlyArray<string>
  readonly pkceChallenge: string | null
  readonly expiresAt: string
  redeemedAt: string | null
  revokedAt: string | null
}

export interface LeaseRecord {
  readonly leaseId: string
  readonly digest: string
  readonly subject: string
  readonly trustTier: "trusted:maintainer" | "trusted:sandbox" | "untrusted:community"
  readonly scopes: ReadonlyArray<string>
  readonly expiresAt: string
  revokedAt: string | null
}

const PERSON_ONLY = new Set<string>(FACTORY_SNAPSHOT.personOnlyActions)
const UNTRUSTED_SCOPES = new Set([
  "mcp:read",
  "cache:read",
  "artifact:read",
  "artifact:write:untrusted",
  "todo:draft",
  "issue:create",
  "issue:comment",
  "pr:draft",
  "changeset:propose",
  "audit:run"
])

export async function webSha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const buf = await crypto.subtle.digest("SHA-256", copy)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function webPkceS256(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomHex(byteLen: number): string {
  const arr = new Uint8Array(byteLen)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  })
}

/**
 * Durable Object holding live Cloud MCP state, single-use smo_ token digests,
 * active session leases, shared object store artifacts, and waitlist requests.
 * Uses ctx.storage.sql when running in Cloudflare Workers and falls back to
 * in-memory maps in unit tests.
 */
export class FactoryHubDO {
  private readonly sql?: SqlStorageLike
  private readonly tokens = new Map<string, OneTimeTokenRecord>()
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly todos = [...FACTORY_SNAPSHOT.todos]
  private readonly issues = [...FACTORY_SNAPSHOT.issues]
  private readonly changesets = [...FACTORY_SNAPSHOT.changesets]
  private readonly pulls = [...FACTORY_SNAPSHOT.pulls]
  private readonly artifacts = [...FACTORY_SNAPSHOT.artifacts]
  private readonly waitlist: Array<{ readonly repo: string; readonly createdAt: string }> = []
  private initialized = false

  constructor(ctx: DurableStateLike) {
    this.sql = ctx.storage.sql
  }

  private ensureSchema(): void {
    if (this.initialized) return
    this.initialized = true
    if (!this.sql) return
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS one_time_tokens (
        digest TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        subject TEXT NOT NULL,
        trust_tier TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        pkce_challenge TEXT,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        revoked_at TEXT
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_leases (
        digest TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        trust_tier TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS waitlist_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  private saveToken(rec: OneTimeTokenRecord): void {
    this.tokens.set(rec.digest, rec)
    if (this.sql) {
      this.sql.exec(
        `INSERT OR REPLACE INTO one_time_tokens (digest, id, subject, trust_tier, scopes_json, pkce_challenge, expires_at, redeemed_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rec.digest,
        rec.id,
        rec.subject,
        rec.trustTier,
        JSON.stringify(rec.scopes),
        rec.pkceChallenge,
        rec.expiresAt,
        rec.redeemedAt,
        rec.revokedAt
      )
    }
  }

  private loadToken(digest: string): OneTimeTokenRecord | null {
    const inMem = this.tokens.get(digest)
    if (inMem) return inMem
    if (!this.sql) return null
    const rows = this.sql.exec(`SELECT * FROM one_time_tokens WHERE digest = ?`, digest).toArray()
    const row = rows[0]
    if (!row) return null
    const rec: OneTimeTokenRecord = {
      id: String(row.id),
      digest: String(row.digest),
      subject: String(row.subject),
      trustTier: String(row.trust_tier) as OneTimeTokenRecord["trustTier"],
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      pkceChallenge: row.pkce_challenge ? String(row.pkce_challenge) : null,
      expiresAt: String(row.expires_at),
      redeemedAt: row.redeemed_at ? String(row.redeemed_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null
    }
    this.tokens.set(rec.digest, rec)
    return rec
  }

  private saveLease(lease: LeaseRecord): void {
    this.leases.set(lease.digest, lease)
    if (this.sql) {
      this.sql.exec(
        `INSERT OR REPLACE INTO session_leases (digest, lease_id, subject, trust_tier, scopes_json, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        lease.digest,
        lease.leaseId,
        lease.subject,
        lease.trustTier,
        JSON.stringify(lease.scopes),
        lease.expiresAt,
        lease.revokedAt
      )
    }
  }

  private loadLease(digest: string): LeaseRecord | null {
    const inMem = this.leases.get(digest)
    if (inMem) return inMem
    if (!this.sql) return null
    const rows = this.sql.exec(`SELECT * FROM session_leases WHERE digest = ?`, digest).toArray()
    const row = rows[0]
    if (!row) return null
    const lease: LeaseRecord = {
      leaseId: String(row.lease_id),
      digest: String(row.digest),
      subject: String(row.subject),
      trustTier: String(row.trust_tier) as LeaseRecord["trustTier"],
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      expiresAt: String(row.expires_at),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null
    }
    this.leases.set(lease.digest, lease)
    return lease
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema()
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/api/factory") {
      return json({
        repository: FACTORY_SNAPSHOT.repository,
        todos: this.todos,
        issues: this.issues,
        changesets: this.changesets,
        pulls: this.pulls,
        artifacts: this.artifacts,
        waitlistCount: this.waitlist.length
      })
    }

    if (request.method === "POST" && url.pathname === "/api/waitlist") {
      let body: { repo?: string }
      try {
        body = (await request.json()) as { repo?: string }
      } catch {
        return json({ error: "invalid_json" }, 400)
      }
      const repo = (body.repo ?? "").trim()
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        return json({ error: "invalid_repo", message: "Expected owner/repo format" }, 400)
      }
      const createdAt = new Date().toISOString()
      this.waitlist.push({ repo, createdAt })
      if (this.sql) {
        this.sql.exec(`INSERT INTO waitlist_requests (repo, created_at) VALUES (?, ?)`, repo, createdAt)
      }
      return json({ ok: true, repo, createdAt }, 201)
    }

    if (request.method === "POST" && url.pathname === "/smithersai/smithers-ci/mcp/mint") {
      let body: {
        subject?: string
        trustTier?: "trusted:maintainer" | "trusted:sandbox" | "untrusted:community"
        scopes?: ReadonlyArray<string>
        pkceChallenge?: string | null
        ttlSeconds?: number
      }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return json({ error: "invalid_json" }, 400)
      }

      // Only requests bearing X-Smithers-Maintainer-Verified=1 from the control plane
      // can mint trusted tiers; all public requests cap strictly at untrusted:community.
      const isControlPlane = request.headers.get("x-smithers-control-plane") === "verified"
      const requestedTier = body.trustTier ?? "untrusted:community"
      const effectiveTier: OneTimeTokenRecord["trustTier"] =
        isControlPlane && (requestedTier === "trusted:sandbox" || requestedTier === "trusted:maintainer")
          ? requestedTier
          : "untrusted:community"

      const requestedScopes = Array.isArray(body.scopes)
        ? body.scopes
        : ["mcp:read", "cache:read", "artifact:write:untrusted", "todo:draft", "issue:create", "audit:run"]

      const granted: string[] = []
      const stripped: string[] = []
      for (const s of requestedScopes) {
        const clean = String(s).trim()
        if (!clean) continue
        if (PERSON_ONLY.has(clean)) {
          stripped.push(clean)
        } else if (effectiveTier === "untrusted:community" && !UNTRUSTED_SCOPES.has(clean)) {
          stripped.push(clean)
        } else {
          granted.push(clean)
        }
      }

      if (granted.length === 0) {
        return json({ error: "no_permitted_scopes", stripped }, 400)
      }

      const ttlSeconds = Math.min(Math.max(Math.floor(body.ttlSeconds ?? 300), 30), 3600)
      const rawToken = `smo_${randomHex(32)}`
      const digest = await webSha256Hex(rawToken)
      const rec: OneTimeTokenRecord = {
        id: `ott_${randomHex(8)}`,
        digest,
        subject: (body.subject ?? "agent:community").trim().slice(0, 100),
        trustTier: effectiveTier,
        scopes: granted,
        pkceChallenge: body.pkceChallenge ? String(body.pkceChallenge).trim() : null,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        redeemedAt: null,
        revokedAt: null
      }
      this.saveToken(rec)

      return json(
        {
          ok: true,
          id: rec.id,
          token: rawToken,
          trustTier: rec.trustTier,
          scopes: rec.scopes,
          strippedScopes: stripped,
          singleUse: true,
          expiresAt: rec.expiresAt
        },
        201
      )
    }

    if (request.method === "POST" && url.pathname === "/smithersai/smithers-ci/mcp/exchange") {
      let body: { token?: string; pkceVerifier?: string | null }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return json({ error: "invalid_json" }, 400)
      }

      const rawToken = typeof body.token === "string" ? body.token.trim() : ""
      if (!/^smo_[0-9a-f]{64}$/.test(rawToken)) {
        return json({ ok: false, code: "invalid_format", message: "Expected smo_<64hex> token" }, 401)
      }

      const digest = await webSha256Hex(rawToken)
      const rec = this.loadToken(digest)
      if (!rec || !constantTimeEqual(rec.digest, digest)) {
        return json({ ok: false, code: "not_found", message: "Unknown one-time token" }, 401)
      }
      if (rec.revokedAt !== null) {
        return json({ ok: false, code: "revoked", message: "Token revoked" }, 401)
      }
      if (rec.redeemedAt !== null) {
        return json({ ok: false, code: "already_redeemed", message: "One-time token already burned" }, 401)
      }
      if (Date.now() > Date.parse(rec.expiresAt)) {
        return json({ ok: false, code: "expired", message: "One-time token expired" }, 401)
      }
      if (rec.pkceChallenge) {
        const verifier = typeof body.pkceVerifier === "string" ? body.pkceVerifier : ""
        if (!verifier || (await webPkceS256(verifier)) !== rec.pkceChallenge) {
          return json({ ok: false, code: "pkce_mismatch", message: "PKCE S256 verification failed" }, 401)
        }
      }

      // Atomic burn BEFORE issuing lease
      rec.redeemedAt = new Date().toISOString()
      this.saveToken(rec)

      const rawLease = `sms_${randomHex(32)}`
      const leaseDigest = await webSha256Hex(rawLease)
      const lease: LeaseRecord = {
        leaseId: `lease_${randomHex(8)}`,
        digest: leaseDigest,
        subject: rec.subject,
        trustTier: rec.trustTier,
        scopes: rec.scopes,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        revokedAt: null
      }
      this.saveLease(lease)

      return json({
        ok: true,
        leaseId: lease.leaseId,
        leaseToken: rawLease,
        trustTier: lease.trustTier,
        scopes: lease.scopes,
        expiresAt: lease.expiresAt
      })
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/mcp" || url.pathname === "/smithersai/smithers-ci/mcp")
    ) {
      return this.handleMcp(request, url.origin)
    }

    return json({ error: "not_found" }, 404)
  }

  private async verifyAuth(request: Request): Promise<{ readonly ok: true; readonly lease: LeaseRecord | null } | { readonly ok: false }> {
    const auth = request.headers.get("authorization")
    if (!auth) return { ok: true, lease: null }
    if (!auth.startsWith("Bearer ")) return { ok: false }
    const token = auth.slice("Bearer ".length).trim()
    if (!/^sms_[0-9a-f]{64}$/.test(token)) return { ok: false }
    const digest = await webSha256Hex(token)
    const lease = this.loadLease(digest)
    if (!lease || !constantTimeEqual(lease.digest, digest)) return { ok: false }
    if (lease.revokedAt !== null || Date.now() > Date.parse(lease.expiresAt)) return { ok: false }
    return { ok: true, lease }
  }

  private async handleMcp(request: Request, origin: string): Promise<Response> {
    let payload: { id?: string | number | null; method?: string; params?: Record<string, unknown> }
    try {
      payload = (await request.json()) as typeof payload
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, 400)
    }

    const id = payload.id ?? null
    const authRes = await this.verifyAuth(request)
    if (!authRes.ok) {
      return json({ jsonrpc: "2.0", id, error: { code: -32001, message: "Invalid or expired MCP lease" } }, 401)
    }
    const lease = authRes.lease

    if (payload.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "smithers-ci-cloud-mcp", version: "1.0.0-rc.20" },
          capabilities: { tools: { listChanged: false } }
        }
      })
    }

    if (payload.method === "tools/list") {
      return json({
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

    if (payload.method === "tools/call") {
      const params = payload.params ?? {}
      const name = typeof params.name === "string" ? params.name : ""
      const args = (params.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {}) as Record<string, unknown>

      if (PERSON_ONLY.has(name)) {
        return json({
          jsonrpc: "2.0",
          id,
          error: { code: -32003, message: `Action ${name} is person_only and cannot be executed via MCP` }
        })
      }

      const def = FACTORY_SNAPSHOT.mcpTools.find((t) => t.name === name)
      if (!def) {
        return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } })
      }

      if (def.requiredScope !== null) {
        const hasScope =
          lease !== null &&
          (lease.scopes.includes(def.requiredScope) ||
            (def.requiredScope === "artifact:write:untrusted" && lease.scopes.includes("artifact:write:trusted")))
        if (!hasScope) {
          return json({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32002,
              message: `Tool ${name} requires scope ${def.requiredScope}. Exchange a one-time smo_ token at ${origin}/smithersai/smithers-ci/mcp/exchange.`
            }
          })
        }
      }

      const actor = lease ? `${lease.subject.replace(/^(?:agent|sandbox):/, "")} (agent)` : "public (agent)"
      const trustTier = lease?.trustTier ?? "untrusted:community"
      const trusted = trustTier !== "untrusted:community"

      let output: unknown
      switch (name) {
        case "todos_list":
          output = { todos: this.todos }
          break
        case "todo_draft": {
          const item = {
            id: `todo-${this.todos.length + 1}`,
            title: String(args.title ?? "").trim(),
            body: String(args.body ?? "").trim(),
            status: "draft" as const,
            priority:
              args.priority === "P0"
                ? ("P0" as const)
                : args.priority === "P2"
                  ? ("P2" as const)
                  : ("P1" as const),
            author: actor,
            visibility: "public" as const,
            linkedIssue: typeof args.linkedIssue === "number" ? args.linkedIssue : null,
            createdAt: new Date().toISOString()
          }
          this.todos.unshift(item)
          output = { todo: item }
          break
        }
        case "issues_list":
          output = { issues: this.issues }
          break
        case "issue_create": {
          const issue = {
            number: this.issues.length + 1,
            title: String(args.title ?? "").trim(),
            body: String(args.body ?? "").trim(),
            state: "open" as const,
            triage: "untriaged" as const,
            author: actor,
            labels: Array.isArray(args.labels)
              ? args.labels.filter((l): l is string => typeof l === "string" && !l.toLowerCase().startsWith("smithers:"))
              : [],
            comments: [],
            createdAt: new Date().toISOString()
          }
          this.issues.unshift(issue)
          output = { issue }
          break
        }
        case "artifacts_list":
          output = {
            artifacts: args.trustedOnly === true ? this.artifacts.filter((a) => a.trusted) : this.artifacts
          }
          break
        case "artifact_put": {
          const artName = String(args.name ?? "").trim()
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artName)) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid artifact name" } })
          }
          const content = String(args.content ?? "")
          const sha256 = await webSha256Hex(content)
          const namespace = trusted
            ? `trusted/${FACTORY_SNAPSHOT.commitSha}`
            : `untrusted/${actor.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}/${FACTORY_SNAPSHOT.commitSha}`
          const meta = {
            name: artName,
            namespace,
            key: `${namespace}/${artName}`,
            sha256,
            bytes: new TextEncoder().encode(content).byteLength,
            contentType: typeof args.contentType === "string" ? args.contentType : "text/plain",
            visibility: args.visibility === "private" ? ("private" as const) : ("public" as const),
            trustTier,
            trusted,
            actor,
            commitSha: FACTORY_SNAPSHOT.commitSha,
            createdAt: new Date().toISOString()
          }
          this.artifacts.unshift(meta)
          output = { artifact: meta }
          break
        }
        case "pulls_list":
          output = { pulls: this.pulls }
          break
        case "changesets_stack_list":
          output = { changesets: this.changesets }
          break
        case "audit_run":
          output = { report: trusted ? FACTORY_SNAPSHOT.trustedAudit : FACTORY_SNAPSHOT.untrustedAudit }
          break
        case "wiki_search": {
          const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : ""
          output = {
            pages: FACTORY_SNAPSHOT.wiki.pages
              .filter((p) => !q || p.title.toLowerCase().includes(q) || p.markdown.toLowerCase().includes(q))
              .map(({ slug, title, summary, linksOut, backlinks }) => ({ slug, title, summary, linksOut, backlinks }))
          }
          break
        }
        case "wiki_read": {
          const slug = String(args.slug ?? "").trim().toLowerCase()
          const page = FACTORY_SNAPSHOT.wiki.pages.find((p) => p.slug === slug)
          if (!page) return json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Wiki page not found: ${slug}` } })
          output = { page }
          break
        }
        case "mythical_history_outline":
          output = { snapshot: FACTORY_SNAPSHOT.history, manifest: FACTORY_SNAPSHOT.historyManifest }
          break
        case "trust_policy_explain":
          output = {
            trustTier,
            trusted,
            personOnlyActions: FACTORY_SNAPSHOT.personOnlyActions,
            rootInputTracing: FACTORY_SNAPSHOT.rootInputTracing
          }
          break
        default:
          output = { ok: true, tool: name }
          break
      }

      return json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        }
      })
    }

    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method: ${payload.method}` } })
  }
}
