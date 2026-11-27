import React, { useEffect, useState } from "react"
import { FACTORY_SNAPSHOT } from "./data/generatedSnapshot.ts"
import { FactoryBoardView } from "./components/FactoryBoardView.tsx"
import { HomeView, type RoleView } from "./components/HomeView.tsx"
import { LighthouseAuditView } from "./components/LighthouseAuditView.tsx"
import { McpAuthConsole } from "./components/McpAuthConsole.tsx"
import { MythicalHistoryView } from "./components/MythicalHistoryView.tsx"
import { WikiView } from "./components/WikiView.tsx"

type TabId = "home" | "audit" | "factory" | "wiki" | "history" | "mcp"

export function App() {
  const [tab, setTab] = useState<TabId>("home")
  const [role, setRole] = useState<RoleView>("maintainer")
  const [theme, setTheme] = useState<"dark" | "light">("dark")
  const [todosCount, setTodosCount] = useState(FACTORY_SNAPSHOT.todos.length)
  const [showWaitlist, setShowWaitlist] = useState(false)
  const [waitlistRepo, setWaitlistRepo] = useState("")
  const [waitlistSubmitted, setWaitlistSubmitted] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme)
  }, [theme])

  useEffect(() => {
    void fetch("/api/factory")
      .then(async (res) => {
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return
        const data = (await res.json()) as { todos?: unknown[] }
        if (Array.isArray(data.todos)) setTodosCount(data.todos.length)
      })
      .catch(() => undefined)
  }, [])

  const selectTab = (next: TabId) => {
    setTab(next)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const auditScore = FACTORY_SNAPSHOT.trustedAudit.overallScore

  return (
    <div className="app-shell">
      <header className="top-header">
        <div className="header-inner">
          <div className="header-row">
            <div className="brand-group">
              <div className="brand-mark" aria-hidden="true">
                S
              </div>
              <div className="repo-crumb">
                <span className="dim">smithers.sh /</span>
                <span className="dim">smithersai /</span>
                <strong>smithers-ci</strong>
              </div>
              <span className="pill pill-pass">Lighthouse {auditScore}/100</span>
              <a
                className="pill"
                href={FACTORY_SNAPSHOT.githubUrl}
                target="_blank"
                rel="noreferrer"
              >
                Mirrored to GitHub
              </a>
            </div>

            <div className="controls-group">
              <span style={{ fontSize: "0.75rem", color: "var(--muted)", fontWeight: 600 }}>View as:</span>
              <div className="role-switcher" role="group" aria-label="Audience personalization switcher">
                <button
                  className={`role-btn ${role === "maintainer" ? "active" : ""}`}
                  onClick={() => setRole("maintainer")}
                >
                  Maintainer
                </button>
                <button
                  className={`role-btn ${role === "contributor" ? "active" : ""}`}
                  onClick={() => setRole("contributor")}
                >
                  Contributor (3)
                </button>
                <button
                  className={`role-btn ${role === "viewer" ? "active" : ""}`}
                  onClick={() => setRole("viewer")}
                >
                  Viewer
                </button>
              </div>
              <button
                className="icon-btn"
                onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                aria-label="Toggle color theme"
              >
                {theme === "dark" ? "Light" : "Dark"}
              </button>
            </div>
          </div>

          <nav className="nav-tabs" aria-label="Repository factory navigation">
            <button className={`nav-tab ${tab === "home" ? "active" : ""}`} onClick={() => selectTab("home")}>
              Home
            </button>
            <button className={`nav-tab ${tab === "audit" ? "active" : ""}`} onClick={() => selectTab("audit")}>
              Lighthouse Audit <span className="tab-count">{auditScore}</span>
            </button>
            <button className={`nav-tab ${tab === "factory" ? "active" : ""}`} onClick={() => selectTab("factory")}>
              Factory & TODOs <span className="tab-count">{todosCount}</span>
            </button>
            <button className={`nav-tab ${tab === "wiki" ? "active" : ""}`} onClick={() => selectTab("wiki")}>
              Wiki <span className="tab-count">{FACTORY_SNAPSHOT.wiki.pages.length}</span>
            </button>
            <button className={`nav-tab ${tab === "history" ? "active" : ""}`} onClick={() => selectTab("history")}>
              Mythical History <span className="tab-count">{FACTORY_SNAPSHOT.history.commits.length}</span>
            </button>
            <button className={`nav-tab ${tab === "mcp" ? "active" : ""}`} onClick={() => selectTab("mcp")}>
              Cloud MCP & Auth <span className="tab-count">{FACTORY_SNAPSHOT.mcpTools.length}</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="main-wrap">
        {tab === "home" && (
          <HomeView
            snapshot={FACTORY_SNAPSHOT}
            role={role}
            onNavigate={selectTab}
            onRequestWaitlist={() => setShowWaitlist(true)}
          />
        )}
        {tab === "audit" && <LighthouseAuditView snapshot={FACTORY_SNAPSHOT} />}
        {tab === "factory" && (
          <FactoryBoardView
            snapshot={FACTORY_SNAPSHOT}
            role={role}
            onTodosCountChange={setTodosCount}
          />
        )}
        {tab === "wiki" && <WikiView snapshot={FACTORY_SNAPSHOT} />}
        {tab === "history" && <MythicalHistoryView snapshot={FACTORY_SNAPSHOT} />}
        {tab === "mcp" && <McpAuthConsole snapshot={FACTORY_SNAPSHOT} role={role} />}
      </main>

      {showWaitlist ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Request Smithers Cloud for your repository"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.65)",
            display: "grid",
            placeItems: "center",
            padding: "1rem",
            zIndex: 60
          }}
        >
          <div className="card" style={{ maxWidth: "460px", width: "100%", boxShadow: "var(--shadow)" }}>
            <div className="card-head">
              <div>
                <h2 className="card-title">Add Your Open-Source Repo to Smithers Cloud</h2>
                <p className="card-sub">
                  Get kernel-recorded incremental CI, Lighthouse backpressure reports, Cloud MCP, Wiki, and Mythical History at smithers.sh/org/repo.
                </p>
              </div>
            </div>
            {waitlistSubmitted ? (
              <div>
                <p style={{ color: "var(--lh-pass)", fontWeight: 600 }}>
                  Request noted for <code>{waitlistRepo}</code>. Self-hosting is open immediately via <code>bunx smithers-ci</code>.
                </p>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setShowWaitlist(false)
                    setWaitlistSubmitted(false)
                    setWaitlistRepo("")
                  }}
                >
                  Done
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const trimmed = waitlistRepo.trim()
                  if (trimmed.length > 2) {
                    setWaitlistSubmitted(true)
                    void fetch("/api/waitlist", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ repo: trimmed })
                    }).catch(() => undefined)
                  }
                }}
              >
                <label style={{ fontSize: "0.8rem", color: "var(--muted)", display: "block", marginBottom: "0.3rem" }}>
                  GitHub Repository (org/repo)
                </label>
                <input
                  className="input"
                  style={{ marginBottom: "0.85rem" }}
                  placeholder="your-org/your-repo"
                  value={waitlistRepo}
                  onChange={(e) => setWaitlistRepo(e.target.value)}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                  <button type="button" className="btn" onClick={() => setShowWaitlist(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Request Access
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}

      <footer className="footer">
        <div className="footer-inner">
          <div>
            <strong>smithers.sh/smithersai/smithers-ci</strong> · Shared object store:{" "}
            <code>{FACTORY_SNAPSHOT.objectStoreEndpoint}</code>
          </div>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <a href={FACTORY_SNAPSHOT.githubUrl} target="_blank" rel="noreferrer">
              GitHub Mirror
            </a>
            <a href={FACTORY_SNAPSHOT.docsUrl} target="_blank" rel="noreferrer">
              ci.smithers.sh
            </a>
            <a href="/llms.txt" target="_blank" rel="noreferrer">
              llms.txt
            </a>
            <a href="/lighthouse-audit.html" target="_blank" rel="noreferrer">
              Standalone Audit HTML
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
