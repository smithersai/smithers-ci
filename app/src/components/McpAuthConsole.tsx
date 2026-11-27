import React, { useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"
import type { RoleView } from "./HomeView.tsx"

interface McpAuthConsoleProps {
  readonly snapshot: FactorySnapshot
  readonly role: RoleView
}

interface LiveMintedToken {
  readonly id: string
  readonly rawToken: string
  readonly pkceVerifier: string
  readonly pkceChallenge: string
  readonly subject: string
  readonly trustTier: "trusted:sandbox" | "trusted:maintainer" | "untrusted:community"
  readonly granted: ReadonlyArray<string>
  readonly stripped: ReadonlyArray<string>
  readonly redeemed: boolean
  readonly source: "live-do" | "local-preview"
}

type PlaygroundTool =
  | "trust_policy_explain"
  | "wiki_search"
  | "mythical_history_outline"
  | "cache_stats"
  | "todos_list"
  | "todo_draft"
  | "artifact_put"
  | "pr/merge"

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function computeBrowserPkceS256(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function McpAuthConsole({ snapshot, role }: McpAuthConsoleProps) {
  const [agentClient, setAgentClient] = useState<"claude" | "codex" | "antigravity">("claude")
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [subject, setSubject] = useState("sandbox:cfbox-gate-09")
  const [tier, setTier] = useState<"trusted:sandbox" | "untrusted:community">(
    role === "maintainer" ? "trusted:sandbox" : "untrusted:community"
  )
  const [minted, setMinted] = useState<LiveMintedToken | null>(null)
  const [mintBusy, setMintBusy] = useState(false)
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeemLog, setRedeemLog] = useState<string | null>(null)
  const [activeLease, setActiveLease] = useState<{
    readonly leaseId: string
    readonly leaseToken: string
    readonly trustTier: string
  } | null>(null)

  const [playgroundTool, setPlaygroundTool] = useState<PlaygroundTool>("trust_policy_explain")
  const [playgroundQuery, setPlaygroundQuery] = useState("isolation")
  const [playgroundOutput, setPlaygroundOutput] = useState<string | null>(null)
  const [playgroundBusy, setPlaygroundBusy] = useState(false)

  const connectPrompts: Record<"claude" | "codex" | "antigravity", string> = {
    claude: `claude mcp add --transport http smithers-ci ${snapshot.mcpEndpoint}`,
    codex: `codex mcp add smithers-ci --url ${snapshot.mcpEndpoint}`,
    antigravity: `Add Streamable HTTP MCP server "${snapshot.mcpEndpoint}" (OAuth 2.1 PKCE S256 discovery enabled)`
  }

  const handleMintLive = async () => {
    setMintBusy(true)
    setRedeemLog(null)
    setActiveLease(null)
    const pkceVerifier = `smithers-browser-pkce-${randomHex(24)}`
    const pkceChallenge = await computeBrowserPkceS256(pkceVerifier)
    const requestedScopes = [
      "mcp:read",
      "mcp:write",
      "cache:read",
      "cache:write",
      "artifact:write:trusted",
      "artifact:write:untrusted",
      "todo:draft",
      "issue:create",
      "changeset:propose",
      "audit:run",
      "pr/merge",
      "secrets/write"
    ]
    const requestedTier = role === "maintainer" ? tier : "untrusted:community"
    const cleanSubject = subject.trim() || "sandbox:cfbox-01"

    try {
      const res = await fetch("/smithersai/smithers-ci/mcp/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: cleanSubject,
          trustTier: requestedTier,
          scopes: requestedScopes,
          pkceChallenge
        })
      })
      const contentType = res.headers.get("content-type") ?? ""
      if (res.ok && contentType.includes("application/json")) {
        const data = (await res.json()) as {
          id: string
          token: string
          trustTier: "trusted:sandbox" | "trusted:maintainer" | "untrusted:community"
          scopes: string[]
          strippedScopes: string[]
        }
        setMinted({
          id: data.id,
          rawToken: data.token,
          pkceVerifier,
          pkceChallenge,
          subject: cleanSubject,
          trustTier: data.trustTier,
          granted: data.scopes,
          stripped: data.strippedScopes,
          redeemed: false,
          source: "live-do"
        })
        setMintBusy(false)
        return
      }
    } catch {
      // Fallback to local preview when running static Vite dev without Worker backend
    }

    const personOnly = new Set<string>(snapshot.personOnlyActions)
    const untrustedAllowed = new Set([
      "mcp:read",
      "cache:read",
      "artifact:write:untrusted",
      "todo:draft",
      "issue:create",
      "changeset:propose",
      "audit:run"
    ])
    const granted: string[] = []
    const stripped: string[] = []
    for (const scope of requestedScopes) {
      if (personOnly.has(scope) || (requestedTier === "untrusted:community" && !untrustedAllowed.has(scope))) {
        stripped.push(scope)
      } else {
        granted.push(scope)
      }
    }
    setMinted({
      id: `ott_${randomHex(6)}`,
      rawToken: `smo_${randomHex(32)}`,
      pkceVerifier,
      pkceChallenge,
      subject: cleanSubject,
      trustTier: requestedTier,
      granted,
      stripped,
      redeemed: false,
      source: "local-preview"
    })
    setMintBusy(false)
  }

  const handleRedeemOnce = async () => {
    if (!minted) return
    setRedeemBusy(true)

    if (minted.source === "live-do") {
      try {
        const res = await fetch("/smithersai/smithers-ci/mcp/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: minted.rawToken,
            pkceVerifier: minted.pkceVerifier
          })
        })
        const data = (await res.json()) as {
          ok: boolean
          leaseId?: string
          leaseToken?: string
          trustTier?: string
          code?: string
          message?: string
        }
        if (res.ok && data.ok && data.leaseToken && data.leaseId) {
          setMinted({ ...minted, redeemed: true })
          setActiveLease({
            leaseId: data.leaseId,
            leaseToken: data.leaseToken,
            trustTier: data.trustTier ?? minted.trustTier
          })
          setRedeemLog(
            `200 OK (Live SQLite DO): Burned ${minted.id} atomically with PKCE S256 and issued lease ${data.leaseId} (${data.trustTier}). Click again to verify 401 replay rejection.`
          )
        } else {
          setMinted({ ...minted, redeemed: true })
          setRedeemLog(
            `${res.status} ${data.code ?? "rejected"} (Live SQLite DO): ${data.message ?? "Single-use token already burned."}`
          )
        }
        setRedeemBusy(false)
        return
      } catch {
        // Fall through to local message
      }
    }

    if (minted.redeemed) {
      setRedeemLog("401 already_redeemed: Single-use token was burned on first exchange and cannot be replayed.")
      setRedeemBusy(false)
      return
    }
    const localLease = `sms_${randomHex(32)}`
    setMinted({ ...minted, redeemed: true })
    setActiveLease({
      leaseId: `lease_${randomHex(6)}`,
      leaseToken: localLease,
      trustTier: minted.trustTier
    })
    setRedeemLog(
      `200 OK: Burned ${minted.id} atomically and issued scoped session lease ${localLease.slice(0, 18)}... (${minted.trustTier}). Click again to verify replay rejection.`
    )
    setRedeemBusy(false)
  }

  const handleRunPlayground = async () => {
    setPlaygroundBusy(true)
    const args: Record<string, unknown> =
      playgroundTool === "wiki_search"
        ? { query: playgroundQuery }
        : playgroundTool === "todo_draft"
          ? {
              title: playgroundQuery.trim().length >= 3 ? playgroundQuery.trim() : "Verify live Cloud MCP TODO persistence",
              body: "Created directly from the live Cloud MCP Playground with a redeemed single-use lease.",
              priority: "P2"
            }
          : playgroundTool === "artifact_put"
            ? {
                name: "playground-preview.txt",
                content: `Smithers CI live playground check: ${playgroundQuery || "ok"}`,
                contentType: "text/plain; charset=utf-8",
                visibility: "public"
              }
            : playgroundTool === "pr/merge"
              ? { number: 101 }
              : {}

    const rpcBody = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: playgroundTool, arguments: args }
    }

    const headers: Record<string, string> = { "content-type": "application/json" }
    if (activeLease) {
      headers.authorization = `Bearer ${activeLease.leaseToken}`
    }

    try {
      const res = await fetch("/smithersai/smithers-ci/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(rpcBody)
      })
      const contentType = res.headers.get("content-type") ?? ""
      if (contentType.includes("application/json")) {
        const json = await res.json()
        setPlaygroundOutput(JSON.stringify({ httpStatus: res.status, response: json }, null, 2))
        setPlaygroundBusy(false)
        return
      }
    } catch {
      // Static local Vite fallback
    }

    setPlaygroundOutput(
      JSON.stringify(
        {
          note: "Static local Vite preview (deploy or run `smithers-ci mcp serve` for live HTTP RPC)",
          request: rpcBody
        },
        null,
        2
      )
    )
    setPlaygroundBusy(false)
  }

  return (
    <div>
      {/* BYOA Public Cloud MCP Connect */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Public Authenticated Cloud MCP Server</h2>
            <p className="card-sub">
              Bring Your Own Agent (BYOA). Connect any Streamable HTTP MCP client with OAuth 2.1 PKCE S256 or a one-time sandbox token.
            </p>
          </div>
          <span className="pill pill-pass">{snapshot.mcpTools.length} live tools</span>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.85rem", flexWrap: "wrap" }}>
          <div className="role-switcher">
            {(["claude", "codex", "antigravity"] as const).map((client) => (
              <button
                key={client}
                className={`role-btn ${agentClient === client ? "active" : ""}`}
                onClick={() => setAgentClient(client)}
              >
                {client === "claude" ? "Claude Code" : client === "codex" ? "Codex" : "Antigravity"}
              </button>
            ))}
          </div>
          <span className="pill pill-break">Endpoint: {snapshot.mcpEndpoint}</span>
        </div>

        <div className="install-box">
          <code>{connectPrompts[agentClient]}</code>
          <button
            className="btn btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(connectPrompts[agentClient])
              setCopiedPrompt(true)
              setTimeout(() => setCopiedPrompt(false), 1500)
            }}
          >
            {copiedPrompt ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="grid-3">
          <div className="stat-card">
            <div className="stat-label">RFC 9728 Resource Metadata</div>
            <code>/.well-known/oauth-protected-resource</code>
          </div>
          <div className="stat-card">
            <div className="stat-label">RFC 8414 Auth Server</div>
            <code>/.well-known/oauth-authorization-server</code>
          </div>
          <div className="stat-card">
            <div className="stat-label">One-Time Exchange</div>
            <code style={{ overflowWrap: "anywhere", fontSize: "0.78rem" }}>POST /smithersai/smithers-ci/mcp/exchange</code>
          </div>
        </div>
      </section>

      {/* Interactive Live One-Time Sandbox Auth Minter */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Live One-Time-Use Sandbox & Agent Auth Minter</h2>
            <p className="card-sub">
              Calls the live Cloudflare Durable Object to mint a single-use <code>smo_</code> token with RFC 7636 PKCE S256, strict scope intersection, and atomic SQLite burn on first exchange.
            </p>
          </div>
          <span className={`pill ${role === "maintainer" ? "pill-pass" : "pill-warn"}`}>
            {role === "maintainer"
              ? "Public browser capped at untrusted until control secret verifies"
              : "Non-maintainers capped at untrusted:community"}
          </span>
        </div>

        <div className="grid-3" style={{ alignItems: "end", marginBottom: "1rem" }}>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
              Sandbox or Agent Subject
            </label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
              Requested Trust Tier
            </label>
            <select
              className="select"
              value={role === "maintainer" ? tier : "untrusted:community"}
              disabled={role !== "maintainer"}
              onChange={(e) => setTier(e.target.value as "trusted:sandbox" | "untrusted:community")}
            >
              <option value="trusted:sandbox">trusted:sandbox (control-plane secret required)</option>
              <option value="untrusted:community">untrusted:community (read-only cache)</option>
            </select>
          </div>
          <button className="btn btn-primary" disabled={mintBusy} onClick={() => void handleMintLive()}>
            {mintBusy ? "Minting..." : "Mint Live One-Time smo_ Token"}
          </button>
        </div>

        {minted ? (
          <div className="stat-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.65rem" }}>
              <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" }}>
                <span className={`pill ${minted.trustTier === "trusted:sandbox" ? "pill-pass" : "pill-warn"}`}>
                  {minted.trustTier}
                </span>
                <code>{minted.id}</code>
                <span className={`pill ${minted.redeemed ? "pill-fail" : "pill-info"}`}>
                  {minted.redeemed ? "BURNED" : "READY (SINGLE USE)"}
                </span>
                <span className="pill">
                  {minted.source === "live-do" ? "Live SQLite DO" : "Local Preview"}
                </span>
              </div>
              <button className="btn btn-sm" disabled={redeemBusy} onClick={() => void handleRedeemOnce()}>
                {minted.redeemed ? "Attempt Replay (Should Return 401)" : "Redeem Once -> Issue Lease"}
              </button>
            </div>
            <pre className="code-block" style={{ marginBottom: "0.65rem" }}>
{[
  `Token ID:       ${minted.id}`,
  `Subject:        ${minted.subject}`,
  `Effective Tier: ${minted.trustTier}`,
  `PKCE S256:      ${minted.pkceChallenge}`,
  `Granted:        ${minted.granted.join(", ")}`,
  `Stripped:       ${minted.stripped.join(", ")} (blocked by trust or person-only policy)`,
  `One-Time Key:   ${minted.rawToken}`
].join("\n")}
            </pre>
            {redeemLog ? (
              <div style={{ fontSize: "0.84rem", color: redeemLog.startsWith("200") ? "var(--lh-pass)" : "var(--lh-fail)" }}>
                <strong>{redeemLog}</strong>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Live MCP RPC Playground */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Live Streamable HTTP MCP Playground</h2>
            <p className="card-sub">
              Send real JSON-RPC 2.0 <code>tools/call</code> requests to the deployed Cloud MCP endpoint. Redeem a one-time token above to test authenticated writes or test <code>pr/merge</code> to verify the <code>-32003 person_only</code> wall.
            </p>
          </div>
          <span className={`pill ${activeLease ? "pill-pass" : "pill-info"}`}>
            {activeLease ? `Authenticated: ${activeLease.leaseId}` : "Anonymous (Public Reads)"}
          </span>
        </div>

        <div className="grid-3" style={{ alignItems: "end", marginBottom: "0.85rem" }}>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
              MCP Tool
            </label>
            <select
              className="select"
              value={playgroundTool}
              onChange={(e) => setPlaygroundTool(e.target.value as PlaygroundTool)}
            >
              <option value="trust_policy_explain">trust_policy_explain (public read)</option>
              <option value="wiki_search">wiki_search (public read)</option>
              <option value="mythical_history_outline">mythical_history_outline (public read)</option>
              <option value="cache_stats">cache_stats (public read)</option>
              <option value="todos_list">todos_list (public read)</option>
              <option value="todo_draft">todo_draft (requires redeemed lease)</option>
              <option value="artifact_put">artifact_put (isolated untrusted/ write)</option>
              <option value="pr/merge">pr/merge (verify -32003 person_only block)</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
              Query / Payload Input
            </label>
            <input
              className="input"
              value={playgroundQuery}
              onChange={(e) => setPlaygroundQuery(e.target.value)}
              placeholder="Search term or TODO title"
            />
          </div>
          <button className="btn btn-primary" disabled={playgroundBusy} onClick={() => void handleRunPlayground()}>
            {playgroundBusy ? "Calling MCP..." : "Execute Live MCP RPC"}
          </button>
        </div>

        {playgroundOutput ? (
          <pre className="code-block" style={{ maxHeight: "300px", overflow: "auto" }}>
            {playgroundOutput}
          </pre>
        ) : null}
      </section>

      {/* Tool Catalog */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Cloud MCP Tool Catalog ({snapshot.mcpTools.length} tools)</h2>
            <p className="card-sub">
              Every agent write carries verified agent attribution. Person-only actions ({snapshot.personOnlyActions.join(", ")}) are never exposed.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Required Scope</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.mcpTools.map((tool) => (
                <tr key={tool.name}>
                  <td>
                    <code>{tool.name}</code>
                  </td>
                  <td>
                    <span className={`pill ${tool.requiredScope ? "pill-info" : "pill-pass"}`}>
                      {tool.requiredScope ?? "public read"}
                    </span>
                  </td>
                  <td style={{ color: "var(--muted)" }}>{tool.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
