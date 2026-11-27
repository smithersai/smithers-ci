import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { inventoryGithubWorkflows } from "./WorkflowInventory.ts"

describe("WorkflowInventory", () => {
  it("audits this repository's own GitHub Actions workflows with zero security findings", () => {
    const inv = inventoryGithubWorkflows(process.cwd())
    expect(inv.workflows.length).toBeGreaterThanOrEqual(2)
    expect(inv.totalJobs).toBeGreaterThanOrEqual(4)
    expect(inv.totalSecurityFindings).toBe(0)
    expect(inv.untrustedSafe).toBe(true)
  })

  it("flags untrusted pull_request workflows that expose write or deploy secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-wf-"))
    const wfDir = join(dir, ".github", "workflows")
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      join(wfDir, "bad-pr.yml"),
      [
        "name: Bad PR",
        "on:",
        "  pull_request:",
        "jobs:",
        "  unsafe:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: echo hi",
        "        env:",
        "          SMITHERS_CACHE_WRITE_TOKEN: ${{ secrets.SMITHERS_CACHE_WRITE_TOKEN }}",
        "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"
      ].join("\n")
    )

    const inv = inventoryGithubWorkflows(dir)
    expect(inv.untrustedSafe).toBe(false)
    expect(inv.totalSecurityFindings).toBeGreaterThanOrEqual(3)
    expect(inv.workflows[0]?.securityFindings.some((f) => f.includes("SMITHERS_CACHE_WRITE_TOKEN"))).toBe(true)
    expect(inv.workflows[0]?.securityFindings.some((f) => f.includes("CLOUDFLARE_API_TOKEN"))).toBe(true)
    expect(inv.workflows[0]?.securityFindings.some((f) => f.includes("persist-credentials: false"))).toBe(true)
  })
})
