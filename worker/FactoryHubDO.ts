import { FACTORY_SNAPSHOT } from "../app/src/data/generatedSnapshot.ts"

export interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>
  readonly rowsWritten?: number
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlCursorLike
}

export interface DurableStateLike {
  readonly storage: {
    readonly sql?: SqlStorageLike
    transactionSync?<T>(closure: () => T): T
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

const ALL_ALLOWED_SCOPES = new Set<string>([
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
  "audit:run",
  "gate:satisfy"
])

const UNTRUSTED_SCOPES = new Set<string>([
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

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/
const MAX_DO_ARTIFACT_BYTES = 64 * 1024 // 64 KiB cap in DO SQLite
const MAX_TEXT_FIELD = 4000
const MAX_TITLE_FIELD = 200

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

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

async function parseJsonObject(request: Request): Promise<{ readonly ok: true; readonly data: Record<string, unknown> } | { readonly ok: false }> {
  try {
    const parsed: unknown = await request.json()
    if (!isPlainObject(parsed)) return { ok: false }
    return { ok: true, data: parsed }
  } catch {
    return { ok: false }
  }
}

/**
 * Durable Object holding live Cloud MCP state, single-use smo_ token digests,
 * active session leases, shared object store artifacts, and waitlist requests.
 * Persists every collection to ctx.storage.sql when running in Cloudflare Workers
 * and falls back to in-memory maps in unit tests.
 */
export class FactoryHubDO {
  private readonly storage: DurableStateLike["storage"]
  private readonly sql?: SqlStorageLike
  private readonly tokens = new Map<string, OneTimeTokenRecord>()
  private readonly leases = new Map<string, LeaseRecord>()
  private todos = [...FACTORY_SNAPSHOT.todos]
  private issues = FACTORY_SNAPSHOT.issues.map((i) => ({ ...i, comments: [...i.comments] }))
  private changesets = [...FACTORY_SNAPSHOT.changesets]
  private pulls = [...FACTORY_SNAPSHOT.pulls]
  private artifacts = [...FACTORY_SNAPSHOT.artifacts]
  private readonly artifactBlobs = new Map<string, string>()
  private readonly waitlist = new Map<string, string>()
  private initialized = false

  constructor(ctx: DurableStateLike) {
    this.storage = ctx.storage
    this.sql = ctx.storage.sql
  }

  private runAtomic<T>(fn: () => T): T {
    if (this.storage.transactionSync) {
      return this.storage.transactionSync(fn)
    }
    return fn()
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
        repo TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `)
    // Idempotent v1 -> v2 schema migration for already-provisioned Durable Objects.
    this.sql.exec(`
      DELETE FROM waitlist_requests
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM waitlist_requests GROUP BY lower(repo)
      );
    `)
    this.sql.exec(`
      UPDATE waitlist_requests SET repo = lower(repo) WHERE repo != lower(repo);
    `)
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_repo_unique ON waitlist_requests (repo);
    `)
    for (const row of this.sql.exec(`SELECT repo, created_at FROM waitlist_requests`).toArray()) {
      this.waitlist.set(String(row.repo).toLowerCase(), String(row.created_at))
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS factory_todos (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS factory_issues (
        number INTEGER PRIMARY KEY,
        data_json TEXT NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS factory_changesets (
        id TEXT PRIMARY KEY,
        stack_position INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS factory_pulls (
        number INTEGER PRIMARY KEY,
        data_json TEXT NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS factory_artifacts (
        key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        content TEXT
      );
    `)

    // Hydrate or seed durable collections so hibernation loses zero state.
    const todoRows = this.sql.exec(`SELECT data_json FROM factory_todos ORDER BY seq DESC`).toArray()
    if (todoRows.length === 0) {
      let seq = 1
      for (const item of [...FACTORY_SNAPSHOT.todos].reverse()) {
        this.sql.exec(
          `INSERT OR IGNORE INTO factory_todos (id, seq, data_json) VALUES (?, ?, ?)`,
          item.id,
          seq++,
          JSON.stringify(item)
        )
      }
    } else {
      this.todos = todoRows.map((r) => JSON.parse(String(r.data_json)))
    }

    const issueRows = this.sql.exec(`SELECT data_json FROM factory_issues ORDER BY number DESC`).toArray()
    if (issueRows.length === 0) {
      for (const item of FACTORY_SNAPSHOT.issues) {
        this.sql.exec(
          `INSERT OR IGNORE INTO factory_issues (number, data_json) VALUES (?, ?)`,
          item.number,
          JSON.stringify(item)
        )
      }
    } else {
      this.issues = issueRows.map((r) => JSON.parse(String(r.data_json)))
    }

    const csRows = this.sql.exec(`SELECT data_json FROM factory_changesets ORDER BY stack_position ASC`).toArray()
    if (csRows.length === 0) {
      for (const item of FACTORY_SNAPSHOT.changesets) {
        this.sql.exec(
          `INSERT OR IGNORE INTO factory_changesets (id, stack_position, data_json) VALUES (?, ?, ?)`,
          item.id,
          item.stackPosition,
          JSON.stringify(item)
        )
      }
    } else {
      this.changesets = csRows.map((r) => JSON.parse(String(r.data_json)))
    }

    const pullRows = this.sql.exec(`SELECT data_json FROM factory_pulls ORDER BY number DESC`).toArray()
    if (pullRows.length === 0) {
      for (const item of FACTORY_SNAPSHOT.pulls) {
        this.sql.exec(
          `INSERT OR IGNORE INTO factory_pulls (number, data_json) VALUES (?, ?)`,
          item.number,
          JSON.stringify(item)
        )
      }
    } else {
      this.pulls = pullRows.map((r) => JSON.parse(String(r.data_json)))
    }

    const artRows = this.sql.exec(`SELECT key, meta_json, content FROM factory_artifacts ORDER BY created_at DESC`).toArray()
    if (artRows.length === 0) {
      for (const item of FACTORY_SNAPSHOT.artifacts) {
        this.sql.exec(
          `INSERT OR IGNORE INTO factory_artifacts (key, created_at, meta_json, content) VALUES (?, ?, ?, ?)`,
          item.key,
          item.createdAt,
          JSON.stringify(item),
          null
        )
      }
    } else {
      this.artifacts = artRows.map((r) => JSON.parse(String(r.meta_json)))
      for (const r of artRows) {
        if (typeof r.content === "string") {
          this.artifactBlobs.set(String(r.key), r.content)
        }
      }
    }
  }

  private pruneExpired(): void {
    const nowIso = new Date().toISOString()
    const nowMs = Date.now()
    for (const [digest, lease] of this.leases.entries()) {
      if (lease.revokedAt !== null || nowMs >= Date.parse(lease.expiresAt)) {
        this.leases.delete(digest)
      }
    }
    for (const [digest, tok] of this.tokens.entries()) {
      if (nowMs >= Date.parse(tok.expiresAt) + 3_600_000) {
        this.tokens.delete(digest)
      }
    }
    if (this.sql) {
      this.sql.exec(`DELETE FROM session_leases WHERE expires_at <= ? OR revoked_at IS NOT NULL`, nowIso)
    }
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

  private loadTokenFresh(digest: string): OneTimeTokenRecord | null {
    if (this.sql) {
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
    return this.tokens.get(digest) ?? null
  }

  private loadLease(digest: string): LeaseRecord | null {
    if (this.sql) {
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
    return this.leases.get(digest) ?? null
  }

  private getWaitlistCount(): number {
    if (this.sql) {
      const rows = this.sql.exec(`SELECT COUNT(*) AS cnt FROM waitlist_requests`).toArray()
      return Number(rows[0]?.cnt ?? 0)
    }
    return this.waitlist.size
  }

  private nextTodoSeq(): number {
    let maxNum = 0
    for (const t of this.todos) {
      const m = /^todo-(\d+)$/.exec(t.id)
      if (m) maxNum = Math.max(maxNum, Number(m[1]))
    }
    return maxNum + 1
  }

  private nextIssueNumber(): number {
    let maxNum = 0
    for (const i of this.issues) {
      maxNum = Math.max(maxNum, i.number)
    }
    return maxNum + 1
  }

  private nextPrNumber(): number {
    let maxNum = 100
    for (const p of this.pulls) {
      maxNum = Math.max(maxNum, p.number)
    }
    return maxNum + 1
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema()
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/api/factory") {
      // Never expose private artifact metadata on the anonymous public endpoint.
      const publicArtifacts = this.artifacts.filter((a) => a.visibility === "public")
      return json({
        repository: FACTORY_SNAPSHOT.repository,
        todos: this.todos,
        issues: this.issues,
        changesets: this.changesets,
        pulls: this.pulls,
        artifacts: publicArtifacts,
        waitlistCount: this.getWaitlistCount()
      })
    }

    if (request.method === "POST" && url.pathname === "/api/waitlist") {
      const parsed = await parseJsonObject(request)
      if (!parsed.ok) {
        return json({ error: "invalid_json" }, 400)
      }
      const repo = typeof parsed.data.repo === "string" ? parsed.data.repo.trim().toLowerCase() : ""
      if (repo.length > 140 || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
        return json({ error: "invalid_repo", message: "Expected owner/repo format" }, 400)
      }
      const createdAt = new Date().toISOString()
      const existed = this.waitlist.has(repo)
      this.waitlist.set(repo, this.waitlist.get(repo) ?? createdAt)
      if (this.sql) {
        this.sql.exec(
          `INSERT OR IGNORE INTO waitlist_requests (repo, created_at) VALUES (?, ?)`,
          repo,
          createdAt
        )
      }
      return json(
        {
          ok: true,
          repo,
          createdAt: this.waitlist.get(repo) ?? createdAt,
          deduplicated: existed,
          waitlistCount: this.getWaitlistCount()
        },
        existed ? 200 : 201
      )
    }

    if (request.method === "POST" && url.pathname === "/smithersai/smithers-ci/mcp/mint") {
      const parsed = await parseJsonObject(request)
      if (!parsed.ok) {
        return json({ error: "invalid_json" }, 400)
      }
      const body = parsed.data

      // Only requests bearing X-Smithers-Control-Plane=verified from the edge worker
      // can mint trusted tiers; all public requests cap strictly at untrusted:community.
      const isControlPlane = request.headers.get("x-smithers-control-plane") === "verified"
      const requestedTier = typeof body.trustTier === "string" ? body.trustTier : "untrusted:community"
      const effectiveTier: OneTimeTokenRecord["trustTier"] =
        isControlPlane && (requestedTier === "trusted:sandbox" || requestedTier === "trusted:maintainer")
          ? requestedTier
          : "untrusted:community"

      let pkceChallenge: string | null = null
      if (body.pkceChallenge !== undefined && body.pkceChallenge !== null) {
        if (typeof body.pkceChallenge !== "string" || !PKCE_CHALLENGE_RE.test(body.pkceChallenge.trim())) {
          return json(
            { error: "invalid_pkce_challenge", message: "pkceChallenge must be a 43-char base64url S256 digest" },
            400
          )
        }
        pkceChallenge = body.pkceChallenge.trim()
      }

      const requestedScopes = Array.isArray(body.scopes)
        ? body.scopes.slice(0, 32)
        : ["mcp:read", "cache:read", "artifact:write:untrusted", "todo:draft", "issue:create", "audit:run"]

      const granted: string[] = []
      const stripped: string[] = []
      const seen = new Set<string>()
      for (const s of requestedScopes) {
        if (typeof s !== "string") continue
        const clean = s.trim()
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        if (PERSON_ONLY.has(clean) || !ALL_ALLOWED_SCOPES.has(clean)) {
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

      const rawTtl = body.ttlSeconds === undefined ? 300 : Number(body.ttlSeconds)
      if (!Number.isFinite(rawTtl)) {
        return json({ error: "invalid_ttl" }, 400)
      }
      const ttlSeconds = Math.min(Math.max(Math.floor(rawTtl), 30), 3600)
      const rawSubject = typeof body.subject === "string" ? body.subject.trim() : "agent:community"
      const subject = rawSubject.replace(/[\s\u0000-\u001f]/g, "-").slice(0, 100) || "agent:community"

      const rawToken = `smo_${randomHex(32)}`
      const digest = await webSha256Hex(rawToken)
      const rec: OneTimeTokenRecord = {
        id: `ott_${randomHex(8)}`,
        digest,
        subject,
        trustTier: effectiveTier,
        scopes: Object.freeze([...granted]),
        pkceChallenge,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        redeemedAt: null,
        revokedAt: null
      }

      this.pruneExpired()
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
          pkceRequired: pkceChallenge !== null,
          expiresAt: rec.expiresAt
        },
        201
      )
    }

    if (request.method === "POST" && url.pathname === "/smithersai/smithers-ci/mcp/exchange") {
      const parsed = await parseJsonObject(request)
      if (!parsed.ok) {
        return json({ error: "invalid_json" }, 400)
      }
      const body = parsed.data

      const rawToken = typeof body.token === "string" ? body.token.trim() : ""
      if (!/^smo_[0-9a-f]{64}$/.test(rawToken)) {
        return json({ ok: false, code: "invalid_format", message: "Expected smo_<64hex> token" }, 401)
      }

      const rawVerifier = typeof body.pkceVerifier === "string" ? body.pkceVerifier : null

      // Precompute ALL async crypto BEFORE entering the atomic synchronous critical section.
      const digest = await webSha256Hex(rawToken)
      const computedPkce =
        rawVerifier !== null && PKCE_VERIFIER_RE.test(rawVerifier)
          ? await webPkceS256(rawVerifier)
          : null
      const rawLease = `sms_${randomHex(32)}`
      const leaseDigest = await webSha256Hex(rawLease)
      const leaseId = `lease_${randomHex(8)}`

      type ExchangeOutcome =
        | { readonly ok: true; readonly lease: LeaseRecord }
        | { readonly ok: false; readonly code: string; readonly message: string }

      const outcome: ExchangeOutcome = this.runAtomic(() => {
        const nowMs = Date.now()
        const nowIso = new Date(nowMs).toISOString()
        const rec = this.loadTokenFresh(digest)
        if (!rec || !constantTimeEqual(rec.digest, digest)) {
          return { ok: false, code: "not_found", message: "Unknown one-time token" }
        }
        if (rec.revokedAt !== null) {
          return { ok: false, code: "revoked", message: "Token revoked" }
        }
        if (rec.redeemedAt !== null) {
          return { ok: false, code: "already_redeemed", message: "One-time token already burned" }
        }
        if (nowMs >= Date.parse(rec.expiresAt)) {
          return { ok: false, code: "expired", message: "One-time token expired" }
        }
        if (rec.pkceChallenge) {
          if (!computedPkce || !constantTimeEqual(computedPkce, rec.pkceChallenge)) {
            return { ok: false, code: "pkce_mismatch", message: "PKCE S256 verification failed" }
          }
        }

        // Conditional compare-and-set burn in SQLite + lease insert in the SAME transaction.
        if (this.sql) {
          const updated = this.sql.exec(
            `UPDATE one_time_tokens
             SET redeemed_at = ?
             WHERE digest = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
            nowIso,
            digest,
            nowIso
          )
          const rowsWritten =
            typeof updated.rowsWritten === "number"
              ? updated.rowsWritten
              : Number(this.sql.exec(`SELECT changes() AS changed`).toArray()[0]?.changed ?? 0)
          if (rowsWritten !== 1) {
            return { ok: false, code: "already_redeemed", message: "One-time token already burned" }
          }
        }

        rec.redeemedAt = nowIso
        this.tokens.set(rec.digest, rec)

        const lease: LeaseRecord = {
          leaseId,
          digest: leaseDigest,
          subject: rec.subject,
          trustTier: rec.trustTier,
          scopes: Object.freeze([...rec.scopes]),
          expiresAt: new Date(nowMs + 3600_000).toISOString(),
          revokedAt: null
        }

        if (this.sql) {
          this.sql.exec(
            `INSERT INTO session_leases (digest, lease_id, subject, trust_tier, scopes_json, expires_at, revoked_at)
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
        this.leases.set(lease.digest, lease)
        return { ok: true, lease }
      })

      if (!outcome.ok) {
        return json({ ok: false, code: outcome.code, message: outcome.message }, 401)
      }

      return json({
        ok: true,
        leaseId: outcome.lease.leaseId,
        leaseToken: rawLease,
        trustTier: outcome.lease.trustTier,
        scopes: outcome.lease.scopes,
        expiresAt: outcome.lease.expiresAt
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

  private async verifyAuth(
    request: Request
  ): Promise<{ readonly ok: true; readonly lease: LeaseRecord | null } | { readonly ok: false }> {
    const auth = request.headers.get("authorization")
    if (!auth) return { ok: true, lease: null }
    if (!auth.startsWith("Bearer ")) return { ok: false }
    const token = auth.slice("Bearer ".length).trim()
    if (!/^sms_[0-9a-f]{64}$/.test(token)) return { ok: false }
    const digest = await webSha256Hex(token)
    const lease = this.loadLease(digest)
    if (!lease || !constantTimeEqual(lease.digest, digest)) return { ok: false }
    if (lease.revokedAt !== null || Date.now() >= Date.parse(lease.expiresAt)) return { ok: false }
    return { ok: true, lease }
  }

  private async handleMcp(request: Request, origin: string): Promise<Response> {
    const parsed = await parseJsonObject(request)
    if (!parsed.ok) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON object" } }, 400)
    }
    const payload = parsed.data

    const rawId = payload.id
    const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
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
      const params = isPlainObject(payload.params) ? payload.params : {}
      const name = typeof params.name === "string" ? params.name : ""
      const args = isPlainObject(params.arguments) ? params.arguments : {}

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

      const rawActor = lease ? lease.subject.replace(/^(?:agent|sandbox):/, "") : "public"
      const actor = `${rawActor} (agent)`
      const trustTier = lease?.trustTier ?? "untrusted:community"
      const trusted = trustTier !== "untrusted:community"

      let output: unknown
      switch (name) {
        case "todos_list":
          output = { todos: this.todos }
          break
        case "todo_draft": {
          const title = typeof args.title === "string" ? args.title.trim().slice(0, MAX_TITLE_FIELD) : ""
          const body = typeof args.body === "string" ? args.body.trim().slice(0, MAX_TEXT_FIELD) : ""
          if (title.length < 3) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "TODO title must be at least 3 characters" } })
          }
          const seq = this.nextTodoSeq()
          const item = {
            id: `todo-${seq}`,
            title,
            body,
            status: "draft" as const,
            priority:
              args.priority === "P0"
                ? ("P0" as const)
                : args.priority === "P2"
                  ? ("P2" as const)
                  : ("P1" as const),
            author: actor,
            visibility: "public" as const,
            linkedIssue: typeof args.linkedIssue === "number" && Number.isFinite(args.linkedIssue) ? args.linkedIssue : null,
            createdAt: new Date().toISOString()
          }
          this.todos.unshift(item)
          if (this.sql) {
            this.sql.exec(
              `INSERT OR REPLACE INTO factory_todos (id, seq, data_json) VALUES (?, ?, ?)`,
              item.id,
              seq,
              JSON.stringify(item)
            )
          }
          output = { todo: item }
          break
        }
        case "issues_list":
          output = { issues: this.issues }
          break
        case "issue_get": {
          const num = Number(args.number)
          const found = this.issues.find((i) => i.number === num)
          if (!found) {
            return json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Issue #${String(args.number)} not found` } })
          }
          output = { issue: found }
          break
        }
        case "issue_create": {
          const title = typeof args.title === "string" ? args.title.trim().slice(0, MAX_TITLE_FIELD) : ""
          const body = typeof args.body === "string" ? args.body.trim().slice(0, MAX_TEXT_FIELD) : ""
          if (title.length < 3) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Issue title must be at least 3 characters" } })
          }
          const num = this.nextIssueNumber()
          const issue = {
            number: num,
            title,
            body,
            state: "open" as const,
            triage: "untriaged" as const,
            author: actor,
            labels: Array.isArray(args.labels)
              ? args.labels
                  .filter((l): l is string => typeof l === "string" && !l.toLowerCase().startsWith("smithers:"))
                  .map((l) => l.trim().slice(0, 40))
                  .filter(Boolean)
                  .slice(0, 10)
              : [],
            comments: [],
            createdAt: new Date().toISOString()
          }
          this.issues.unshift(issue)
          if (this.sql) {
            this.sql.exec(
              `INSERT OR REPLACE INTO factory_issues (number, data_json) VALUES (?, ?)`,
              issue.number,
              JSON.stringify(issue)
            )
          }
          output = { issue }
          break
        }
        case "issue_comment": {
          const num = Number(args.number)
          const body = typeof args.body === "string" ? args.body.trim().slice(0, MAX_TEXT_FIELD) : ""
          const found = this.issues.find((i) => i.number === num)
          if (!found) {
            return json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Issue #${String(args.number)} not found` } })
          }
          if (!body) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Comment body cannot be empty" } })
          }
          found.comments.push({ author: actor, body, at: new Date().toISOString() })
          if (this.sql) {
            this.sql.exec(
              `INSERT OR REPLACE INTO factory_issues (number, data_json) VALUES (?, ?)`,
              found.number,
              JSON.stringify(found)
            )
          }
          output = { issue: found }
          break
        }
        case "artifacts_list": {
          const includePrivate = Boolean(
            lease && lease.trustTier !== "untrusted:community" && lease.scopes.includes("artifact:read")
          )
          const visible = this.artifacts.filter((a) => {
            if (args.trustedOnly === true && !a.trusted) return false
            if (!includePrivate && a.visibility !== "public") return false
            return true
          })
          output = { artifacts: visible }
          break
        }
        case "artifact_put": {
          const artName = typeof args.name === "string" ? args.name.trim() : ""
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artName)) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid artifact name" } })
          }
          const content = typeof args.content === "string" ? args.content : ""
          const contentBytes = new TextEncoder().encode(content).byteLength
          if (contentBytes > MAX_DO_ARTIFACT_BYTES) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: `Artifact exceeds ${MAX_DO_ARTIFACT_BYTES} bytes` } })
          }
          const sha256 = await webSha256Hex(content)
          // Destination requires BOTH trusted tier AND explicit artifact:write:trusted scope.
          const canWriteTrusted =
            trusted && lease !== null && lease.scopes.includes("artifact:write:trusted")
          const safeActorSlug = rawActor.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "community"
          const namespace = canWriteTrusted
            ? `trusted/${FACTORY_SNAPSHOT.commitSha}`
            : `untrusted/${safeActorSlug}/${FACTORY_SNAPSHOT.commitSha}`
          const meta = {
            name: artName,
            namespace,
            key: `${namespace}/${artName}`,
            sha256,
            bytes: contentBytes,
            contentType: typeof args.contentType === "string" ? args.contentType.slice(0, 120) : "text/plain",
            visibility: args.visibility === "private" ? ("private" as const) : ("public" as const),
            trustTier: canWriteTrusted ? trustTier : ("untrusted:community" as const),
            trusted: canWriteTrusted,
            actor,
            commitSha: FACTORY_SNAPSHOT.commitSha,
            createdAt: new Date().toISOString()
          }
          this.artifacts = [meta, ...this.artifacts.filter((a) => a.key !== meta.key)]
          this.artifactBlobs.set(meta.key, content)
          if (this.sql) {
            this.sql.exec(
              `INSERT OR REPLACE INTO factory_artifacts (key, created_at, meta_json, content) VALUES (?, ?, ?, ?)`,
              meta.key,
              meta.createdAt,
              JSON.stringify(meta),
              content
            )
          }
          output = { artifact: meta }
          break
        }
        case "cache_stats":
          output = {
            stats: {
              ...FACTORY_SNAPSHOT.storeStats,
              trustedArtifacts: this.artifacts.filter((a) => a.trusted).length,
              untrustedArtifacts: this.artifacts.filter((a) => !a.trusted).length
            }
          }
          break
        case "pulls_list":
          output = { pulls: this.pulls }
          break
        case "pull_draft": {
          const title = typeof args.title === "string" ? args.title.trim().slice(0, MAX_TITLE_FIELD) : ""
          const body = typeof args.body === "string" ? args.body.trim().slice(0, MAX_TEXT_FIELD) : ""
          const branch = typeof args.branch === "string" ? args.branch.trim().slice(0, 120) : ""
          if (title.length < 3 || !branch) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "PR title and branch are required" } })
          }
          const num = this.nextPrNumber()
          const pr = {
            number: num,
            title,
            body,
            branch,
            baseBranch: typeof args.baseBranch === "string" ? args.baseBranch.trim().slice(0, 80) : "main",
            headCommitSha: FACTORY_SNAPSHOT.commitSha,
            author: actor,
            authorContributions: trusted ? 10 : 1,
            state: "open" as const,
            changesetIds: Array.isArray(args.changesetIds)
              ? args.changesetIds.filter((c): c is string => typeof c === "string").slice(0, 20)
              : [],
            trustTier,
            auditScore: 0,
            gateSatisfied: false,
            gateReceipt: null,
            mirrorSyncedToGithub: true,
            createdAt: new Date().toISOString()
          }
          this.pulls.unshift(pr)
          if (this.sql) {
            this.sql.exec(
              `INSERT OR REPLACE INTO factory_pulls (number, data_json) VALUES (?, ?)`,
              pr.number,
              JSON.stringify(pr)
            )
          }
          output = { pull: pr }
          break
        }
        case "changesets_stack_list":
          output = { changesets: this.changesets }
          break
        case "changeset_propose": {
          const title = typeof args.title === "string" ? args.title.trim().slice(0, MAX_TITLE_FIELD) : ""
          const branch = typeof args.branch === "string" ? args.branch.trim().slice(0, 120) : ""
          const diffSummary = typeof args.diffSummary === "string" ? args.diffSummary.trim().slice(0, MAX_TEXT_FIELD) : ""
          if (title.length < 3 || !branch) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Changeset title and branch are required" } })
          }
          const pos = this.changesets.length + 1
          const cs = {
            id: `cs-${String(pos).padStart(2, "0")}`,
            stackPosition: pos,
            parentId:
              typeof args.parentId === "string"
                ? args.parentId
                : this.changesets[this.changesets.length - 1]?.id ?? null,
            branch,
            title,
            commitSha: FACTORY_SNAPSHOT.commitSha,
            author: actor,
            trustTier,
            auditScore: 0,
            gateSatisfied: false,
            gateReceipt: null,
            state: "draft" as const,
            diffSummary,
            updatedAt: new Date().toISOString()
          }
          this.changesets.push(cs)
          if (this.sql) {
            this.sql.exec(
              `INSERT OR REPLACE INTO factory_changesets (id, stack_position, data_json) VALUES (?, ?, ?)`,
              cs.id,
              cs.stackPosition,
              JSON.stringify(cs)
            )
          }
          output = { changeset: cs }
          break
        }
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
          return json({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Tool ${name} is only available on local filesystem MCP servers (run \`smithers-ci mcp serve\`).`
            }
          })
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

    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method: ${String(payload.method)}` } })
  }
}
