/**
 * The coding factory that develops smithersai/smithers-ci on Smithers Cloud
 * (https://smithers.sh/smithersai/smithers-ci), mirroring to GitHub
 * (https://github.com/smithersai/smithers-ci).
 *
 * Projected into .smithers/factory.json and .smithers/home.json.
 */
export const factory = {
  summary:
    "Smithers CI: kernel-recorded incremental CI, Lighthouse backpressure audits, shared cloud object store, authenticated Cloud MCP, Obsidian wiki, and Mythical History.",
  maintainers: ["roninjin10"],
  mcpEndpoint: "https://smithers.sh/smithersai/smithers-ci/mcp",
  objectStore: "https://build.smithers.sh",
  trustPolicy: {
    trustedTiers: ["trusted:maintainer", "trusted:sandbox"],
    encourageUntrustedCommunityRuns: true,
    untrustedCanReadCache: true,
    untrustedCanWriteCache: false,
    untrustedCanSatisfyGates: false,
    personOnlyActions: [
      "pr/merge",
      "todo/commit",
      "todo/drop",
      "release/publish",
      "secrets/write",
      "policy/update",
      "maintainer/add"
    ]
  },
  mirror: {
    source: "https://smithers.sh/smithersai/smithers-ci",
    github: "https://github.com/smithersai/smithers-ci",
    onMergeToMain: ["audit", "docs-publish", "wiki-refresh", "mythical-history", "release"]
  },
  flows: [
    {
      id: "ci",
      path: ".smithers/flows/ci/flow.ts",
      featured: true,
      summary: "Run strict typecheck, security tests, wiki check, home check, and Lighthouse backpressure audit."
    },
    {
      id: "audit",
      path: ".smithers/flows/audit/flow.ts",
      featured: true,
      summary: "Generate the 6-category Lighthouse backpressure audit report and upload it to the shared object store."
    },
    {
      id: "release",
      path: ".smithers/flows/release/flow.ts",
      featured: true,
      summary: "Pack tarballs, verify trusted Lighthouse score >= 90, publish to npm with provenance, and cut a GitHub Release."
    },
    {
      id: "docs-publish",
      path: ".smithers/flows/docs-publish/flow.ts",
      featured: true,
      summary: "Publish the personalized Factory UI, Obsidian wiki, llms.txt, and Lighthouse audit report to ci.smithers.sh."
    },
    {
      id: "wiki",
      path: ".smithers/flows/wiki/flow.ts",
      featured: true,
      summary: "Check wiki freshness, verify zero broken wikilinks and visual-first diagrams, and update llms.txt."
    },
    {
      id: "mythical-history",
      path: ".smithers/flows/mythical-history/flow.ts",
      featured: true,
      summary: "Fold merged commits into the linear Mythical History stack and verify the deterministic export manifest."
    },
    {
      id: "pr-triage",
      path: ".smithers/flows/pr-triage/flow.mdx",
      featured: true,
      summary: "Triage pull requests from diff and untrusted preview receipts without running untrusted code on maintainer hosts."
    },
    {
      id: "untrusted-replay",
      path: ".smithers/flows/untrusted-replay/flow.mdx",
      featured: true,
      summary: "Run community replay benchmarks inside an isolated Cloudflare Sandbox with read-only cache access."
    }
  ]
} as const
