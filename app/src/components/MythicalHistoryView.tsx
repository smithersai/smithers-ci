import React, { useMemo, useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"

interface MythicalHistoryViewProps {
  readonly snapshot: FactorySnapshot
}

export function MythicalHistoryView({ snapshot }: MythicalHistoryViewProps) {
  const [query, setQuery] = useState("")
  const [selectedEpic, setSelectedEpic] = useState<string>("all")

  const commits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return snapshot.history.commits.filter((c) => {
      if (selectedEpic !== "all" && c.epicId !== selectedEpic) return false
      if (!q) return true
      return (
        c.title.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.notes.some((n) => n.text.toLowerCase().includes(q))
      )
    })
  }, [snapshot.history.commits, query, selectedEpic])

  return (
    <div>
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Mythical History Linear Stack</h2>
            <p className="card-sub">
              Every landed commit folds onto one deterministic epic stack with Tried and Evidence notes preserved across rebases
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
            <span className="pill pill-pass">seq #{snapshot.history.seq}</span>
            <span className="pill">manifest {snapshot.historyManifest.manifestDigest.slice(0, 12)}</span>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.65rem", alignItems: "center", marginBottom: "1rem" }}>
          <input
            className="input"
            style={{ maxWidth: "300px" }}
            placeholder="Search commits, lanes, or evidence..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="role-switcher">
            <button
              className={`role-btn ${selectedEpic === "all" ? "active" : ""}`}
              onClick={() => setSelectedEpic("all")}
            >
              All epics ({snapshot.history.epics.length})
            </button>
            {snapshot.history.epics.map((epic) => (
              <button
                key={epic.id}
                className={`role-btn ${selectedEpic === epic.id ? "active" : ""}`}
                onClick={() => setSelectedEpic(epic.id)}
              >
                Epic {epic.order}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-2" style={{ marginBottom: "1.1rem" }}>
          {snapshot.history.epics.map((epic) => (
            <div key={epic.id} className="stat-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="pill pill-info">EPIC {epic.order}</span>
                <code>{epic.id}</code>
              </div>
              <h3 style={{ margin: "0.45rem 0 0.25rem", fontSize: "0.95rem" }}>{epic.title}</h3>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{epic.summary}</p>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          {commits.map((commit) => {
            const manifestEntry = snapshot.historyManifest.entries.find((e) => e.id === commit.id)
            return (
              <div
                key={commit.id}
                className="stat-card"
                style={{ borderLeft: `3px solid ${commit.state === "landed" ? "var(--lh-pass)" : "var(--info)"}` }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span className={`pill ${commit.state === "landed" ? "pill-pass" : "pill-info"}`}>
                      {commit.id} · {commit.state.toUpperCase()}
                    </span>
                    <strong>{commit.title}</strong>
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    {commit.lane ? <span className="pill">lane: {commit.lane}</span> : null}
                    {manifestEntry ? (
                      <code style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        {manifestEntry.deterministicHash.slice(0, 10)}
                      </code>
                    ) : null}
                  </div>
                </div>

                {commit.notes.map((note, idx) => (
                  <div key={idx} style={{ marginTop: "0.55rem", fontSize: "0.84rem" }}>
                    <span className={`pill ${note.section === "evidence" ? "pill-pass" : "pill-warn"}`} style={{ marginRight: "0.45rem" }}>
                      {note.section.toUpperCase()}
                    </span>
                    <span style={{ color: "var(--muted)" }}>{note.text}</span>
                  </div>
                ))}

                {commit.foldedRealCommits.length > 0 ? (
                  <div style={{ marginTop: "0.6rem", paddingTop: "0.5rem", borderTop: "1px solid var(--line)", fontSize: "0.78rem", color: "var(--muted)" }}>
                    <strong>Folded real commits:</strong>{" "}
                    {commit.foldedRealCommits.map((r) => (
                      <span key={r.sha} style={{ marginRight: "0.75rem" }}>
                        <code>{r.sha.slice(0, 12)}</code> ({r.message})
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Atomic Git Export Refs</h3>
            <p className="card-sub">Published via one compare-and-swap transaction, never modifying main</p>
          </div>
        </div>
        <div className="grid-3">
          <div className="stat-card">
            <div className="stat-label">Linear Bookmark</div>
            <code>{snapshot.historyManifest.refs.mythicalBookmark}</code>
          </div>
          <div className="stat-card">
            <div className="stat-label">Structured Notes Ref</div>
            <code>{snapshot.historyManifest.refs.notesRef}</code>
          </div>
          <div className="stat-card">
            <div className="stat-label">Manifest Ref</div>
            <code>{snapshot.historyManifest.refs.manifestRef}</code>
          </div>
        </div>
      </section>
    </div>
  )
}
