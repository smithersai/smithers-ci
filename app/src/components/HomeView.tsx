import React, { useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"
import { LighthouseGauge } from "./LighthouseGauge.tsx"
import { ReplayShowcaseCard } from "./ReplayShowcaseCard.tsx"

export type RoleView = "maintainer" | "contributor" | "viewer"

interface HomeViewProps {
  readonly snapshot: FactorySnapshot
  readonly role: RoleView
  readonly onNavigate: (tab: "home" | "audit" | "factory" | "wiki" | "history" | "mcp") => void
  readonly onRequestWaitlist: () => void
}

export function HomeView({ snapshot, role, onNavigate, onRequestWaitlist }: HomeViewProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const [branchNotice, setBranchNotice] = useState<string | null>(null)

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1600)
  }

  const audit = snapshot.trustedAudit

  return (
    <div>
      {/* Personalized Audience Banner */}
      <div className={`audience-banner ${role}`}>
        <div>
          {role === "maintainer" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span className="pill pill-pass">MAINTAINER VIEW</span>
                <strong>roninjin10</strong>
                <span style={{ color: "var(--muted)", fontSize: "0.84rem" }}>
                  Full command center with branch actions, one-time sandbox auth, merge gates, and mirror releases.
                </span>
              </div>
            </>
          )}
          {role === "contributor" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span className="pill pill-info">CONTRIBUTOR VIEW</span>
                <strong>alice-dev · 3 contributions</strong>
                <span style={{ color: "var(--muted)", fontSize: "0.84rem" }}>
                  Unlocked after your first landed contribution. Run untrusted previews with warm cache reads and track your stacked changesets.
                </span>
              </div>
            </>
          )}
          {role === "viewer" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span className="pill">VIEWER · 0 CONTRIBUTIONS</span>
                <strong>Public Repository Showcase</strong>
                <span style={{ color: "var(--muted)", fontSize: "0.84rem" }}>
                  Explore live backpressure audits, public TODOs, wiki, and Mythical History. Land 1 contribution to unlock Contributor view.
                </span>
              </div>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {role === "maintainer" && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setBranchNotice("Prepared branch roninjin10/ci-next on Smithers Cloud workspace.")}
            >
              New branch (B)
            </button>
          )}
          {role === "contributor" && (
            <button className="btn btn-primary btn-sm" onClick={() => onNavigate("mcp")}>
              Connect BYOA via MCP
            </button>
          )}
          {role === "viewer" && (
            <button className="btn btn-primary btn-sm" onClick={onRequestWaitlist}>
              Add your repo to Smithers Cloud
            </button>
          )}
        </div>
      </div>

      {branchNotice && role === "maintainer" ? (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "var(--lh-pass)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}>
            <span>
              <strong>Branch workspace ready:</strong> {branchNotice}
            </span>
            <button className="btn btn-sm" onClick={() => setBranchNotice(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {/* Maintainer-Only Command Strip */}
      {role === "maintainer" && (
        <section className="card" style={{ marginBottom: "1.15rem" }}>
          <div className="card-head">
            <div>
              <h2 className="card-title">Today on smithers-ci</h2>
              <p className="card-sub">
                Maintainer operations for smithers.sh/smithersai/smithers-ci mirrored to GitHub main
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button className="btn btn-sm" onClick={() => onNavigate("mcp")}>
                Mint one-time sandbox token
              </button>
              <button className="btn btn-sm" onClick={() => onNavigate("factory")}>
                Review merge queue ({snapshot.pulls.filter((p) => p.state === "open").length})
              </button>
            </div>
          </div>

          <div className="grid-4">
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--lh-pass)" }}>
                {audit.overallScore}/100
              </div>
              <div className="stat-label">Trusted Lighthouse Gate</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{snapshot.todos.filter((t) => t.status !== "done").length} open</div>
              <div className="stat-label">Public TODO Stack</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--lh-avg)" }}>
                1 untrusted PR
              </div>
              <div className="stat-label">Awaiting sandbox rerun (#102)</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">Auto-armed</div>
              <div className="stat-label">Mirror → Docs & Release</div>
            </div>
          </div>
        </section>
      )}

      {/* Contributor-Only Fast-Track Workbench */}
      {role === "contributor" && (
        <section className="card" style={{ marginBottom: "1.15rem" }}>
          <div className="card-head">
            <div>
              <h2 className="card-title">Your Contributor Workbench</h2>
              <p className="card-sub">
                Because you have 3 landed contributions, your active PR, stacked changesets, and untrusted preview tools surface first
              </p>
            </div>
            <button className="btn btn-sm" onClick={() => onNavigate("audit")}>
              Inspect your untrusted preview (96/100)
            </button>
          </div>
          <div className="grid-3">
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--info)" }}>
                PR #102
              </div>
              <div className="stat-label">Track Zig static archive inputs (96/100 preview)</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--lh-pass)" }}>
                Warm Cache ON
              </div>
              <div className="stat-label">Read-only hits from build.smithers.sh</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">cs-04</div>
              <div className="stat-label">Stacked changeset ready for sandbox certification</div>
            </div>
          </div>
        </section>
      )}

      {/* Shared Hero Section (tailored actions per audience) */}
      <section className="card">
        <div className="hero-grid">
          <div>
            <span className="pill pill-pass">PUBLIC ON SMITHERS CLOUD · MIRRORED TO GITHUB</span>
            <h1 className="hero-title">Smithers CI</h1>
            <p className="hero-tagline">
              Fast kernel-recorded incremental CI with zero stale passes, a 0 to 100 Lighthouse backpressure audit report,
              shared cloud object store caching, and an authenticated Cloud MCP server for every agent.
            </p>
            <div className="install-box">
              <code>bunx smithers-ci --commits 4</code>
              <button
                className="btn btn-sm"
                onClick={() => copyText("install", "bunx smithers-ci --commits 4")}
              >
                {copied === "install" ? "Copied" : "Copy"}
              </button>
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={() => onNavigate("audit")}>
                Open Lighthouse Audit ({audit.overallScore}/100)
              </button>
              <button className="btn" onClick={() => onNavigate("wiki")}>
                Browse Wiki ({snapshot.wiki.pages.length} pages)
              </button>
              <button className="btn" onClick={() => onNavigate("history")}>
                Mythical History ({snapshot.history.commits.length} commits)
              </button>
            </div>
          </div>

          <div
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              padding: "1rem",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: "0.75rem"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: "0.9rem" }}>Live Backpressure Snapshot</strong>
              <span className="pill pill-pass">{audit.policy.provenanceBadge}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem" }}>
              {audit.categories.map((cat) => (
                <LighthouseGauge key={cat.id} label={cat.shortTitle} score={cat.score} size={74} />
              ))}
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", textAlign: "center" }}>
              Shared store: <code>{snapshot.objectStoreEndpoint}</code> · Gate: <strong>{audit.gate.status}</strong>
            </div>
          </div>
        </div>
      </section>

      {/* Key Metrics */}
      <section className="card">
        <div className="grid-4">
          <div className="stat-card">
            <div className="stat-value">0 mismatches</div>
            <div className="stat-label">Kernel-recorded smthrs-observe parity</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">387 theorems</div>
            <div className="stat-label">Lean 4 formal specs with 0 sorry</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">4.4x faster</div>
            <div className="stat-label">Measured docs-only cached replay</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">20 MCP tools</div>
            <div className="stat-label">One-time smo_ sandbox auth + PKCE</div>
          </div>
        </div>
      </section>

      {/* Dogfooding Measured Replay Showcase */}
      <ReplayShowcaseCard />

      {/* Four Pillar Cards */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">How This Coding Factory Works</h2>
            <p className="card-sub">
              Built so every open-source maintainer can see what permanent software development on Smithers Cloud feels like
            </p>
          </div>
        </div>
        <div className="grid-2">
          <div className="stat-card">
            <span className="pill pill-pass">BACKPRESSURE</span>
            <h3 style={{ margin: "0.55rem 0 0.3rem", fontSize: "0.98rem" }}>Lighthouse Audit Report</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
              Replaces unreadable CI logs with 0 to 100 radial gauges, expandable diagnostic evidence, cold-vs-cached waterfalls, and root-input security traces.
            </p>
          </div>
          <div className="stat-card">
            <span className="pill pill-warn">TRUST ISOLATION</span>
            <h3 style={{ margin: "0.55rem 0 0.3rem", fontSize: "0.98rem" }}>Open Community Runs Without Cache Poisoning</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
              Anyone can run untrusted checks and enjoy warm cache reads. Only attested Smithers sandboxes and maintainers can write `/ac` or clear merge gates.
            </p>
          </div>
          <div className="stat-card">
            <span className="pill pill-info">CLOUD MCP</span>
            <h3 style={{ margin: "0.55rem 0 0.3rem", fontSize: "0.98rem" }}>Agent-Native Workflow & One-Time Sandbox Auth</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
              Every agent connects over Streamable HTTP MCP to create artifacts, draft TODOs, file issues, and stack changesets using single-use `smo_` tokens.
            </p>
          </div>
          <div className="stat-card">
            <span className="pill">AUTO MIRROR</span>
            <h3 style={{ margin: "0.55rem 0 0.3rem", fontSize: "0.98rem" }}>Merge on Smithers Cloud → Release on GitHub</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
              Merging to `main` mirrors straight to GitHub and triggers trusted backpressure audits, docs and wiki publishing, Mythical History folds, and npm releases.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
