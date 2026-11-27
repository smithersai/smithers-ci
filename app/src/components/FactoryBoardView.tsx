import React, { useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"
import type { RoleView } from "./HomeView.tsx"

interface FactoryBoardViewProps {
  readonly snapshot: FactorySnapshot
  readonly role: RoleView
}

export function FactoryBoardView({ snapshot, role }: FactoryBoardViewProps) {
  const [todos, setTodos] = useState(() => [...snapshot.todos])
  const [newTodoTitle, setNewTodoTitle] = useState("")
  const [newTodoBody, setNewTodoBody] = useState("")
  const [actionBanner, setActionBanner] = useState<string | null>(null)
  const [artifactFilter, setArtifactFilter] = useState<"all" | "trusted" | "untrusted">("all")

  const handleDraftTodo = (e: React.FormEvent) => {
    e.preventDefault()
    if (newTodoTitle.trim().length < 3) return
    const actor = role === "maintainer" ? "roninjin10" : role === "contributor" ? "alice-dev" : "guest"
    setTodos((prev) => [
      {
        id: `todo-${prev.length + 1}`,
        title: newTodoTitle.trim(),
        body: newTodoBody.trim() || "Drafted via Smithers Cloud MCP todo_draft.",
        status: "draft",
        priority: "P1",
        author: `${actor} (agent)`,
        visibility: "public",
        linkedIssue: null,
        createdAt: new Date().toISOString()
      },
      ...prev
    ])
    setNewTodoTitle("")
    setNewTodoBody("")
    setActionBanner("Drafted TODO on public stack via todo_draft. Committing a TODO remains person-only.")
  }

  const handleCommitTodo = (id: string) => {
    if (role !== "maintainer") {
      setActionBanner(`Refused (403 maintainer_required): Only a repository maintainer acting in person can commit ${id}.`)
      return
    }
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, status: "committed" } : t)))
    setActionBanner(`Committed ${id} in person as roninjin10.`)
  }

  const visibleArtifacts = snapshot.artifacts.filter((a) => {
    if (artifactFilter === "trusted") return a.trusted
    if (artifactFilter === "untrusted") return !a.trusted
    return true
  })

  return (
    <div>
      {actionBanner ? (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "var(--info)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}>
            <span>{actionBanner}</span>
            <button className="btn btn-sm" onClick={() => setActionBanner(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}

      {/* Public TODO Stack */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Public TODO Stack</h2>
            <p className="card-sub">
              Visible to everyone. Agents draft TODOs over Cloud MCP while maintainers commit them in person.
            </p>
          </div>
          <span className="pill pill-pass">{todos.length} public items</span>
        </div>

        <form onSubmit={handleDraftTodo} className="grid-3" style={{ marginBottom: "1rem", alignItems: "end" }}>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
              Draft TODO title (MCP `todo_draft`)
            </label>
            <input
              className="input"
              value={newTodoTitle}
              onChange={(e) => setNewTodoTitle(e.target.value)}
              placeholder="Example: Add Cargo workspace shard hints"
            />
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
              Notes
            </label>
            <input
              className="input"
              value={newTodoBody}
              onChange={(e) => setNewTodoBody(e.target.value)}
              placeholder="Acceptance criteria and backpressure gate"
            />
          </div>
          <button className="btn btn-primary" type="submit">
            Draft TODO via MCP
          </button>
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Author</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {todos.map((todo) => (
                <tr key={todo.id}>
                  <td>
                    <code>{todo.id}</code>
                  </td>
                  <td>
                    <strong>{todo.title}</strong>
                    <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{todo.body}</div>
                  </td>
                  <td>
                    <span className="pill">{todo.priority}</span>
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        todo.status === "done" || todo.status === "committed"
                          ? "pill-pass"
                          : todo.status === "in_progress"
                            ? "pill-info"
                            : "pill-warn"
                      }`}
                    >
                      {todo.status}
                    </span>
                  </td>
                  <td>
                    <code>{todo.author}</code>
                  </td>
                  <td className="num">
                    {todo.status === "draft" ? (
                      <button className="btn btn-sm" onClick={() => handleCommitTodo(todo.id)}>
                        Commit (person-only)
                      </button>
                    ) : (
                      <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Stacked Changesets & Pull Requests */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Stacked Changesets & Pull Requests</h2>
            <p className="card-sub">
              Linear changeset stack showing trusted sandbox gates vs untrusted community previews
            </p>
          </div>
          <span className="pill">{snapshot.changesets.length} changesets · {snapshot.pulls.length} PRs</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stack</th>
                <th>Changeset & Branch</th>
                <th>Trust Tier</th>
                <th className="num">Lighthouse</th>
                <th>Gate</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.changesets.map((cs) => (
                <tr key={cs.id}>
                  <td>
                    <code>#{cs.stackPosition} {cs.id}</code>
                    {cs.parentId ? (
                      <div style={{ fontSize: "0.73rem", color: "var(--muted)" }}>parent: {cs.parentId}</div>
                    ) : null}
                  </td>
                  <td>
                    <strong>{cs.title}</strong>
                    <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                      <code>{cs.branch}</code> · {cs.diffSummary}
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${cs.trustTier === "untrusted:community" ? "pill-warn" : "pill-pass"}`}>
                      {cs.trustTier}
                    </span>
                  </td>
                  <td className="num" style={{ fontWeight: 700, color: "var(--lh-pass)" }}>
                    {cs.auditScore}/100
                  </td>
                  <td>
                    <span className={`pill ${cs.gateSatisfied ? "pill-pass" : "pill-warn"}`}>
                      {cs.gateSatisfied ? "SATISFIED" : "PREVIEW ONLY"}
                    </span>
                  </td>
                  <td>
                    <span className="pill">{cs.state}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Shared Object Store Artifacts */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Shared Smithers Cloud Object Store Artifacts</h2>
            <p className="card-sub">
              Endpoint: <code>{snapshot.objectStoreEndpoint}</code> · Trusted artifacts live under <code>trusted/</code>, community previews isolate under <code>untrusted/</code>
            </p>
          </div>
          <div className="role-switcher">
            {(["all", "trusted", "untrusted"] as const).map((f) => (
              <button
                key={f}
                className={`role-btn ${artifactFilter === f ? "active" : ""}`}
                onClick={() => setArtifactFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Object Key</th>
                <th>Trust Tier</th>
                <th>SHA-256</th>
                <th className="num">Size</th>
                <th>Visibility</th>
              </tr>
            </thead>
            <tbody>
              {visibleArtifacts.map((art) => (
                <tr key={art.key}>
                  <td>
                    <code>{art.key}</code>
                  </td>
                  <td>
                    <span className={`pill ${art.trusted ? "pill-pass" : "pill-warn"}`}>{art.trustTier}</span>
                  </td>
                  <td>
                    <code>{art.sha256.slice(0, 16)}</code>
                  </td>
                  <td className="num">{(art.bytes / 1024).toFixed(1)} KB</td>
                  <td>
                    <span className="pill">{art.visibility}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Public Issues */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Public Issues</h2>
            <p className="card-sub">Synced two-way between Smithers Cloud and GitHub</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Issue</th>
                <th>Triage</th>
                <th>Author</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.issues.map((issue) => (
                <tr key={issue.number}>
                  <td>
                    <code>#{issue.number}</code>
                  </td>
                  <td>
                    <strong>{issue.title}</strong>
                    <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{issue.body}</div>
                  </td>
                  <td>
                    <span className="pill">{issue.triage}</span>
                  </td>
                  <td>
                    <code>{issue.author}</code>
                  </td>
                  <td>
                    <span className={`pill ${issue.state === "open" ? "pill-info" : "pill-pass"}`}>
                      {issue.state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
