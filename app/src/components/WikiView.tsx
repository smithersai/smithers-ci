import React, { useMemo, useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"
import { WikiDiagram } from "./WikiDiagram.tsx"

interface WikiViewProps {
  readonly snapshot: FactorySnapshot
}

function renderInlineText(
  text: string,
  onSelectSlug: (slug: string) => void
): ReadonlyArray<React.ReactNode> {
  const parts: React.ReactNode[] = []
  const tokenRe = /(\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith("[[")) {
      const inner = token.slice(2, -2)
      const [rawSlug, rawLabel] = inner.split("|")
      const slug = (rawSlug ?? "").trim().toLowerCase()
      const label = (rawLabel ?? rawSlug ?? "").trim()
      parts.push(
        <button key={key++} className="wikilink-btn" onClick={() => onSelectSlug(slug)}>
          [[{label}]]
        </button>
      )
    } else if (token.startsWith("`")) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

function MarkdownBlocks({
  slug,
  markdown,
  onSelectSlug
}: {
  readonly slug: string
  readonly markdown: string
  readonly onSelectSlug: (slug: string) => void
}) {
  const lines = markdown.split("\n")
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  let renderedPrimaryDiagram = false

  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "")
        i += 1
      }
      i += 1
      if (!renderedPrimaryDiagram && (lang === "mermaid" || lang === "text")) {
        renderedPrimaryDiagram = true
        blocks.push(<WikiDiagram key={key++} slug={slug} />)
      } else {
        blocks.push(
          <div key={key++} style={{ margin: "0.75rem 0 1rem" }}>
            {lang ? (
              <div style={{ fontSize: "0.72rem", fontFamily: "var(--mono)", color: "var(--muted)", marginBottom: "0.25rem" }}>
                {lang.toUpperCase()}
              </div>
            ) : null}
            <pre className="code-block">{codeLines.join("\n")}</pre>
          </div>
        )
      }
      continue
    }

    if (line.startsWith("# ")) {
      blocks.push(
        <h2 key={key++} style={{ margin: "0 0 0.65rem", fontSize: "1.4rem", letterSpacing: "-0.02em" }}>
          {line.slice(2)}
        </h2>
      )
      i += 1
      continue
    }
    if (line.startsWith("## ")) {
      blocks.push(
        <h3 key={key++} style={{ margin: "1.25rem 0 0.5rem", fontSize: "1.05rem" }}>
          {line.slice(3)}
        </h3>
      )
      i += 1
      continue
    }
    if (line.startsWith("- ")) {
      const items: string[] = []
      while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
        items.push((lines[i] ?? "").slice(2))
        i += 1
      }
      blocks.push(
        <ul key={key++} style={{ margin: "0.4rem 0 0.85rem", paddingLeft: "1.2rem" }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: "0.25rem 0" }}>
              {renderInlineText(item, onSelectSlug)}
            </li>
          ))}
        </ul>
      )
      continue
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s/, ""))
        i += 1
      }
      blocks.push(
        <ol key={key++} style={{ margin: "0.4rem 0 0.85rem", paddingLeft: "1.25rem" }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: "0.25rem 0" }}>
              {renderInlineText(item, onSelectSlug)}
            </li>
          ))}
        </ol>
      )
      continue
    }
    if (line.startsWith("|")) {
      const tableLines: string[] = []
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        tableLines.push(lines[i] ?? "")
        i += 1
      }
      const rows = tableLines
        .filter((row) => !/^\|\s*---/.test(row))
        .map((row) =>
          row
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim())
        )
      const [header, ...body] = rows
      blocks.push(
        <div key={key++} className="table-wrap" style={{ margin: "0.75rem 0 1rem" }}>
          <table>
            {header ? (
              <thead>
                <tr>
                  {header.map((cell, ci) => (
                    <th key={ci}>{cell}</th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>{renderInlineText(cell, onSelectSlug)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (line.trim() === "") {
      i += 1
      continue
    }
    blocks.push(
      <p key={key++} style={{ margin: "0.5rem 0" }}>
        {renderInlineText(line, onSelectSlug)}
      </p>
    )
    i += 1
  }

  return <div>{blocks}</div>
}

export function WikiView({ snapshot }: WikiViewProps) {
  const [selectedSlug, setSelectedSlug] = useState<string>("index")
  const [search, setSearch] = useState("")

  const filteredPages = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return snapshot.wiki.pages
    return snapshot.wiki.pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.markdown.toLowerCase().includes(q)
    )
  }, [snapshot.wiki.pages, search])

  const activePage =
    snapshot.wiki.pages.find((p) => p.slug === selectedSlug) ?? snapshot.wiki.pages[0]

  if (!activePage) {
    return <div className="card">No wiki pages found.</div>
  }

  return (
    <div className="wiki-layout">
      {/* Left Sidebar */}
      <aside className="card" style={{ padding: "0.95rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <strong style={{ fontSize: "0.86rem" }}>Obsidian Wiki</strong>
          <span className="pill pill-pass">{snapshot.wiki.pages.length} pages</span>
        </div>
        <input
          className="input"
          style={{ marginBottom: "0.7rem" }}
          placeholder="Search wiki..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {filteredPages.map((page) => (
            <button
              key={page.slug}
              className={`wiki-nav-item ${page.slug === activePage.slug ? "active" : ""}`}
              onClick={() => setSelectedSlug(page.slug)}
            >
              {page.title}
            </button>
          ))}
        </div>
        <div style={{ marginTop: "0.85rem", paddingTop: "0.7rem", borderTop: "1px solid var(--line)", fontSize: "0.74rem", color: "var(--muted)" }}>
          Broken links: <strong>{snapshot.wiki.brokenLinks.length}</strong> · Digest:{" "}
          <code>{snapshot.wiki.digest.slice(0, 10)}</code>
        </div>
      </aside>

      {/* Center Document */}
      <article className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <span className="pill">{activePage.filePath}</span>
          <span className="pill pill-pass">{activePage.hasDiagram ? "Visual-first diagram verified" : "No diagram"}</span>
        </div>
        <MarkdownBlocks slug={activePage.slug} markdown={activePage.markdown} onSelectSlug={setSelectedSlug} />
      </article>

      {/* Right Backlinks & Graph */}
      <aside className="card" style={{ padding: "0.95rem" }}>
        <strong style={{ fontSize: "0.84rem", display: "block", marginBottom: "0.5rem" }}>
          Backlinks ({activePage.backlinks.length})
        </strong>
        {activePage.backlinks.length === 0 ? (
          <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: 0 }}>No incoming links.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {activePage.backlinks.map((slug) => (
              <button key={slug} className="wiki-nav-item wiki-link-row" onClick={() => setSelectedSlug(slug)}>
                ← {slug}
              </button>
            ))}
          </div>
        )}

        <strong style={{ fontSize: "0.84rem", display: "block", margin: "1rem 0 0.5rem" }}>
          Outgoing Links ({activePage.linksOut.length})
        </strong>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          {activePage.linksOut.map((slug) => (
            <button key={slug} className="wiki-nav-item wiki-link-row" onClick={() => setSelectedSlug(slug)}>
              → {slug}
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}
