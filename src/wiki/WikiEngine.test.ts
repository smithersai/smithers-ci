import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateLlmsTxt, loadWikiGraph, searchWiki } from "./WikiEngine.ts"

describe("WikiEngine", () => {
  it("resolves wikilinks, builds backlinks, flags broken links, and generates llms.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-wiki-"))
    writeFileSync(
      join(dir, "index.md"),
      "---\ntitle: Home\nsummary: Start here\n---\n# Home\n```mermaid\ngraph LR\nA-->B\n```\nInline example `[[not-a-link]]` is ignored. See [[kernel-observer]] and [[missing-page]].\n"
    )
    writeFileSync(
      join(dir, "kernel-observer.md"),
      "---\ntitle: Kernel Observer\nsummary: Seccomp recording\n---\n# Kernel Observer\n```text\nbox -> observe -> cas\n```\nBack to [[index]].\n"
    )

    const graph = loadWikiGraph(dir)
    expect(graph.pages).toHaveLength(2)
    expect(graph.brokenLinks).toEqual([{ from: "index", target: "missing-page" }])
    expect(graph.pagesWithoutDiagrams).toEqual([])

    const obs = graph.pages.find((p) => p.slug === "kernel-observer")
    expect(obs?.backlinks).toEqual(["index"])

    expect(searchWiki(graph, "seccomp")).toHaveLength(1)
    expect(generateLlmsTxt(graph)).toContain("https://ci.smithers.sh/wiki/kernel-observer")
  })
})
