import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

export interface WikiPage {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly owner: string
  readonly filePath: string
  readonly sha256: string
  readonly hasDiagram: boolean
  readonly linksOut: ReadonlyArray<string>
  readonly backlinks: ReadonlyArray<string>
  readonly headings: ReadonlyArray<string>
  readonly markdown: string
}

export interface WikiGraph {
  readonly pages: ReadonlyArray<WikiPage>
  readonly brokenLinks: ReadonlyArray<{ readonly from: string; readonly target: string }>
  readonly pagesWithoutDiagrams: ReadonlyArray<string>
  readonly digest: string
}

function stripCodeForWikilinks(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
}

function parseFrontmatter(raw: string): {
  readonly meta: Record<string, string>
  readonly body: string
} {
  if (!raw.startsWith("---\n")) {
    return { meta: {}, body: raw }
  }
  const end = raw.indexOf("\n---\n", 4)
  if (end === -1) return { meta: {}, body: raw }
  const block = raw.slice(4, end)
  const meta: Record<string, string> = {}
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "")
      meta[key] = val
    }
  }
  return { meta, body: raw.slice(end + 5) }
}

export function loadWikiGraph(wikiDir: string): WikiGraph {
  const dir = resolve(wikiDir)
  if (!existsSync(dir)) {
    return { pages: [], brokenLinks: [], pagesWithoutDiagrams: [], digest: "" }
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()

  const draftPages = files.map((file) => {
    const filePath = join(dir, file)
    const raw = readFileSync(filePath, "utf8")
    const { meta, body } = parseFrontmatter(raw)
    const slug = file.replace(/\.md$/, "").toLowerCase()
    const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
    const title = meta.title ?? firstHeading ?? slug
    const summary = meta.summary ?? meta.description ?? ""
    const owner = meta.owner ?? "smithers-ci"
    const sha256 = createHash("sha256").update(raw, "utf8").digest("hex")
    const hasDiagram = body.includes("```mermaid") || body.includes("```text") || body.includes("<svg")

    const linksOut = Array.from(
      new Set(
        Array.from(stripCodeForWikilinks(body).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
          .map((m) => (m[1] ?? "").trim().toLowerCase())
          .filter((s) => s.length > 0)
      )
    )

    const headings = Array.from(body.matchAll(/^#{1,3}\s+(.+)$/gm)).map((m) => (m[1] ?? "").trim())

    return {
      slug,
      title,
      summary,
      owner,
      filePath: `wiki/${file}`,
      sha256,
      hasDiagram,
      linksOut,
      headings,
      markdown: body.trim()
    }
  })

  const validSlugs = new Set(draftPages.map((p) => p.slug))
  const backlinkMap = new Map<string, string[]>()
  const brokenLinks: Array<{ readonly from: string; readonly target: string }> = []

  for (const page of draftPages) {
    for (const target of page.linksOut) {
      if (!validSlugs.has(target)) {
        brokenLinks.push({ from: page.slug, target })
      } else {
        const list = backlinkMap.get(target) ?? []
        list.push(page.slug)
        backlinkMap.set(target, list)
      }
    }
  }

  const pages: WikiPage[] = draftPages.map((page) => ({
    ...page,
    backlinks: (backlinkMap.get(page.slug) ?? []).sort()
  }))

  const pagesWithoutDiagrams = pages.filter((p) => !p.hasDiagram).map((p) => p.slug)
  const digest = createHash("sha256")
    .update(pages.map((p) => `${p.slug}:${p.sha256}`).join("\n"))
    .digest("hex")

  return { pages, brokenLinks, pagesWithoutDiagrams, digest }
}

export function searchWiki(graph: WikiGraph, query: string): ReadonlyArray<WikiPage> {
  const q = query.trim().toLowerCase()
  if (!q) return graph.pages
  return graph.pages.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      p.summary.toLowerCase().includes(q) ||
      p.markdown.toLowerCase().includes(q)
  )
}

export function generateLlmsTxt(graph: WikiGraph, baseUrl = "https://ci.smithers.sh"): string {
  const lines = [
    "# Smithers CI",
    "",
    "> Fast kernel-recorded incremental CI, Lighthouse backpressure audits, Cloud MCP, Wiki, and Mythical History built publicly on Smithers Cloud.",
    "",
    "## Wiki & Architecture",
    ""
  ]
  for (const page of graph.pages) {
    lines.push(`- [${page.title}](${baseUrl}/wiki/${page.slug}): ${page.summary || page.title}`)
  }
  lines.push("")
  return lines.join("\n")
}
