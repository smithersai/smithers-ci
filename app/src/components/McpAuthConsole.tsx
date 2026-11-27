import React, { useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"
import type { RoleView } from "./HomeView.tsx"

interface McpAuthConsoleProps {
  readonly snapshot: FactorySnapshot
  readonly role: RoleView
}

interface DemoMintedToken {
  readonly id: string
  readonly rawPreview: string
  readonly subject: string
  readonly trustTier: "trusted:sandbox" | "trusted:maintainer" | "untrusted:community"
  readonly granted: ReadonlyArray<string>
  readonly stripped: ReadonlyArray<string>
  readonly redeemed: boolean
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function McpAuthConsole({ snapshot, role }: McpAuthConsoleProps) {
  const [agentClient, setAgentClient] = useState<"claude" | "codex" | "antigravity">("claude")
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [subject, setSubject] = useState("sandbox:cfbox-gate-09")
  const [tier, setTier] = useState<"trusted:sandbox" | "untrusted:community">(
    role === "maintainer" ? "trusted:sandbox" : "untrusted:community"
  )
  const [minted, setMinted] = useState<DemoMintedToken | null>(null)
  const [redeemLog, setRedeemLog] = useState<string | null>(null)

  const connectPrompts: Record<"claude" | "codex" | "antigravity", string> = {
    claude: `claude mcp add --transport http smithers-ci ${snapshot.mcpEndpoint}`,
    codex: `codex mcp add smithers-ci --url ${snapshot.mcpEndpoint}`,
    antigravity: `Add Streamable HTTP MCP server "${snapshot.mcpEndpoint}" (OAuth 2.1 PKCE S256 discovery enabled)`
  }

  const handleMintPreview = () => {
    const requested = [
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

    const effectiveTier = role === "maintainer" ? tier : "untrusted:community"
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
    for (const scope of requested) {
      if (personOnly.has(scope)) {
        stripped.push(scope)
      } else if (effectiveTier === "untrusted:community" && !untrustedAllowed.has(scope)) {
        stripped.push(scope)
      } else {
        granted.push(scope)
      }
    }

    setMinted({
      id: `ott_${randomHex(6)}`,
      rawPreview: `smo_${randomHex(32)}`,
      subject: subject.trim() || "sandbox:cfbox-01",
      trustTier: effectiveTier,
      granted,
      stripped,
      redeemed: false
    })
    setRedeemLog(null)
  }

  const handleRedeemOnce = () => {
    if (!minted) return
    if (minted.redeemed) {
      setRedeemLog("401 already_redeemed: Single-use token was burned on first exchange and cannot be replayed.")
      return
    }
    setMinted({ ...minted, redeemed: true })
    setRedeemLog(
      `200 OK: Burned ${minted.id} atomically and issued scoped session lease sms_${randomHex(12)}... (${minted.trustTier}). Click again to verify replay rejection.`
    )
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
          <span className="pill">Endpoint: {snapshot.mcpEndpoint}</span>
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
            <code>POST /smithersai/smithers-ci/mcp/exchange</code>
          </div>
        </div>
      </section>

      {/* Interactive One-Time Sandbox Auth Minter */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">One-Time-Use Sandbox & Agent Auth Minter</h2>
            <p className="card-sub">
              Print single-use <code>smo_</code> tokens that store only SHA-256 digests, intersect scopes against trust policy, and burn atomically on first exchange
            </p>
          </div>
          <span className={`pill ${role === "maintainer" ? "pill-pass" : "pill-warn"}`}>
            {role === "maintainer" ? "Maintainer may mint trusted:sandbox" : "Non-maintainers capped at untrusted:community"}
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
              Trust Tier
            </label>
            <select
              className="select"
              value={role === "maintainer" ? tier : "untrusted:community"}
              disabled={role !== "maintainer"}
              onChange={(e) => setTier(e.target.value as "trusted:sandbox" | "untrusted:community")}
            >
              <option value="trusted:sandbox">trusted:sandbox (controlled container)</option>
              <option value="untrusted:community">untrusted:community (read-only cache)</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleMintPreview}>
            Print One-Time smo_ Token
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
              </div>
              <button className="btn btn-sm" onClick={handleRedeemOnce}>
                {minted.redeemed ? "Attempt Replay (Should Fail)" : "Redeem Once -> Issue Lease"}
              </button>
            </div>
            <pre className="code-block" style={{ marginBottom: "0.65rem" }}>
{[
  `Token ID:     ${minted.id}`,
  `Subject:      ${minted.subject}`,
  `Trust Tier:   ${minted.trustTier}`,
  `Granted:      ${minted.granted.join(", ")}`,
  `Stripped:     ${minted.stripped.join(", ")} (blocked by trust or person-only policy)`,
  `One-Time Key: ${minted.rawPreview}`
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

      {/* Tool Catalog */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Cloud MCP Tool Catalog ({snapshot.mcpTools.length} tools)</h2>
            <p className="card-sub">
              Every agent write attributes as <code>&lt;login&gt; (agent)</code>. Person-only actions ({snapshot.personOnlyActions.join(", ")}) are never exposed.
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
