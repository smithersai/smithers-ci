import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

export interface WorkflowJobSummary {
  readonly id: string
  readonly name: string
  readonly runsOn: string
  readonly stepsCount: number
  readonly usesCacheWriteSecret: boolean
  readonly usesDeploySecret: boolean
  readonly usesNpmSecret: boolean
  readonly hasPersistCredentialsFalse: boolean
  readonly splitCandidates: ReadonlyArray<string>
}

export interface WorkflowFileInventory {
  readonly file: string
  readonly name: string
  readonly triggers: ReadonlyArray<string>
  readonly handlesUntrustedPrs: boolean
  readonly jobs: ReadonlyArray<WorkflowJobSummary>
  readonly securityFindings: ReadonlyArray<string>
}

export interface RepositoryWorkflowInventory {
  readonly workflowsDir: string
  readonly workflows: ReadonlyArray<WorkflowFileInventory>
  readonly totalJobs: number
  readonly totalSteps: number
  readonly totalSecurityFindings: number
  readonly untrustedSafe: boolean
}

const WRITE_SECRET_RE = /secrets\.SMITHERS_CACHE_WRITE_TOKEN/
const DEPLOY_SECRET_RE = /secrets\.CLOUDFLARE_API_TOKEN/
const NPM_SECRET_RE = /secrets\.NPM_TOKEN/

/**
 * Lightweight, zero-dependency GitHub Actions workflow inventory and trust-boundary
 * auditor. Parses `.github/workflows/*.{yml,yaml}`, discovers triggers, jobs, steps,
 * split candidates, and verifies that untrusted pull_request workflows never touch
 * write, deploy, or publish secrets.
 */
export function inventoryGithubWorkflows(repoRoot: string): RepositoryWorkflowInventory {
  const workflowsDir = join(resolve(repoRoot), ".github", "workflows")
  if (!existsSync(workflowsDir)) {
    return {
      workflowsDir,
      workflows: [],
      totalJobs: 0,
      totalSteps: 0,
      totalSecurityFindings: 0,
      untrustedSafe: true
    }
  }

  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()

  const workflows: WorkflowFileInventory[] = []

  for (const file of files) {
    const raw = readFileSync(join(workflowsDir, file), "utf8")
    const lines = raw.split(/\r?\n/)
    const nameMatch = raw.match(/^name:\s*(.+)$/m)
    const workflowName = nameMatch ? nameMatch[1]!.trim().replace(/^["']|["']$/g, "") : file

    // Parse top-level `on:` triggers
    const triggers: string[] = []
    let inOn = false
    for (const line of lines) {
      if (/^on:\s*$/.test(line)) {
        inOn = true
        continue
      }
      if (/^on:\s*(.+)$/.test(line)) {
        const inline = line.replace(/^on:\s*/, "").trim()
        if (inline.startsWith("[") && inline.endsWith("]")) {
          for (const t of inline.slice(1, -1).split(",")) {
            const clean = t.trim()
            if (clean) triggers.push(clean)
          }
        } else if (inline) {
          triggers.push(inline)
        }
        inOn = false
        continue
      }
      if (inOn) {
        if (/^\S/.test(line) && !line.startsWith("#")) {
          inOn = false
          continue
        }
        const trigMatch = line.match(/^  ([a-z_]+):/)
        if (trigMatch?.[1]) triggers.push(trigMatch[1])
      }
    }

    const handlesUntrustedPrs = triggers.includes("pull_request") || triggers.includes("pull_request_target")

    // Parse top-level `jobs:` blocks
    const jobs: WorkflowJobSummary[] = []
    let inJobs = false
    let currentJobId: string | null = null
    let currentJobLines: string[] = []

    const flushJob = () => {
      if (!currentJobId) return
      const block = currentJobLines.join("\n")
      const jobName = block.match(/^    name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? currentJobId
      const runsOn = block.match(/^    runs-on:\s*(.+)$/m)?.[1]?.trim() ?? "unknown"
      const stepsCount = (block.match(/^      - /gm) ?? []).length
      const usesCacheWriteSecret = WRITE_SECRET_RE.test(block)
      const usesDeploySecret = DEPLOY_SECRET_RE.test(block)
      const usesNpmSecret = NPM_SECRET_RE.test(block)
      const hasPersistCredentialsFalse = /persist-credentials:\s*false/.test(block)

      const splitCandidates: string[] = []
      if (/\bbun run full-check\b/.test(block)) splitCandidates.push("fast-check + medium-check + build:ui")
      if (/\bvitest\b|\bbun run test\b/.test(block)) splitCandidates.push("test-shards")
      if (/\btsc\b|\bbun run typecheck\b/.test(block)) splitCandidates.push("typecheck")

      jobs.push({
        id: currentJobId,
        name: jobName,
        runsOn,
        stepsCount,
        usesCacheWriteSecret,
        usesDeploySecret,
        usesNpmSecret,
        hasPersistCredentialsFalse,
        splitCandidates
      })
    }

    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true
        continue
      }
      if (inJobs) {
        if (/^\S/.test(line) && !line.startsWith("#")) {
          flushJob()
          currentJobId = null
          inJobs = false
          continue
        }
        const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
        if (jobMatch?.[1]) {
          flushJob()
          currentJobId = jobMatch[1]
          currentJobLines = []
          continue
        }
        if (currentJobId) {
          currentJobLines.push(line)
        }
      }
    }
    flushJob()

    const securityFindings: string[] = []
    for (const job of jobs) {
      if (!job.hasPersistCredentialsFalse) {
        securityFindings.push(`${file}:${job.id} checkout does not set persist-credentials: false`)
      }
      if (handlesUntrustedPrs && job.usesCacheWriteSecret) {
        securityFindings.push(`${file}:${job.id} exposes SMITHERS_CACHE_WRITE_TOKEN to untrusted pull_request`)
      }
      if (handlesUntrustedPrs && job.usesDeploySecret) {
        securityFindings.push(`${file}:${job.id} exposes CLOUDFLARE_API_TOKEN to untrusted pull_request`)
      }
      if (handlesUntrustedPrs && job.usesNpmSecret) {
        securityFindings.push(`${file}:${job.id} exposes NPM_TOKEN to untrusted pull_request`)
      }
    }

    workflows.push({
      file,
      name: workflowName,
      triggers,
      handlesUntrustedPrs,
      jobs,
      securityFindings
    })
  }

  const totalJobs = workflows.reduce((s, w) => s + w.jobs.length, 0)
  const totalSteps = workflows.reduce((s, w) => s + w.jobs.reduce((js, j) => js + j.stepsCount, 0), 0)
  const totalSecurityFindings = workflows.reduce((s, w) => s + w.securityFindings.length, 0)

  return {
    workflowsDir,
    workflows,
    totalJobs,
    totalSteps,
    totalSecurityFindings,
    untrustedSafe: totalSecurityFindings === 0
  }
}
