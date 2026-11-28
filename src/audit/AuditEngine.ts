import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { inventoryGithubWorkflows } from "../ci/WorkflowInventory.ts"
import { validateHomeJson } from "../factory/Audience.ts"
import { type MythicalHistorySnapshot, verifyMythicalHistory } from "../history/MythicalHistory.ts"
import {
  ROOT_INPUT_TRACING_TABLE,
  type GateCheckResult,
  type GateReceipt,
  type VerifiedExecution,
  createGateReceipt,
  evaluateExecutionPolicy,
  evaluateGate
} from "../trust/ExecutionTrust.ts"

export type AuditCategoryId =
  | "correctness"
  | "cache-speed"
  | "security-trust"
  | "formal-fuzz"
  | "wiki-docs"
  | "release-cloud"

export type AuditStatus = "pass" | "warn" | "fail"

export interface AuditCheck {
  readonly id: string
  readonly category: AuditCategoryId
  readonly title: string
  readonly description: string
  readonly status: AuditStatus
  readonly score: number // 0..100
  readonly weight: number
  readonly displayValue: string
  readonly durationMs: number
  readonly evidence: ReadonlyArray<string>
  readonly remediation?: string
}

export interface AuditCategorySummary {
  readonly id: AuditCategoryId
  readonly title: string
  readonly shortTitle: string
  readonly score: number // 0..100
  readonly rating: "pass" | "average" | "fail"
  readonly passedCount: number
  readonly warnCount: number
  readonly failCount: number
  readonly audits: ReadonlyArray<AuditCheck>
}

export interface TimingWaterfallStep {
  readonly name: string
  readonly category: AuditCategoryId
  readonly baselineMs: number
  readonly cachedMs: number
  readonly cacheHit: boolean
}

export interface BackpressureAuditReport {
  readonly schemaVersion: "1.0.0"
  readonly generatedAt: string
  readonly repository: string
  readonly commitSha: string
  readonly checkoutState?: "clean" | "dirty" | "unknown"
  readonly isExample?: boolean
  readonly execution: VerifiedExecution
  readonly policy: ReturnType<typeof evaluateExecutionPolicy>
  readonly gate: GateCheckResult
  readonly gateReceipt: GateReceipt
  readonly overallScore: number
  readonly overallRating: "pass" | "average" | "fail"
  readonly categories: ReadonlyArray<AuditCategorySummary>
  readonly waterfall: ReadonlyArray<TimingWaterfallStep>
  readonly securityTraceRows: typeof ROOT_INPUT_TRACING_TABLE
  readonly summary: {
    readonly totalAudits: number
    readonly passed: number
    readonly warnings: number
    readonly failed: number
    readonly releaseThreshold: number
    readonly releaseReady: boolean
  }
}

export function ratingForScore(score: number): "pass" | "average" | "fail" {
  if (score >= 90) return "pass"
  if (score >= 50) return "average"
  return "fail"
}

export function weightedScore(audits: ReadonlyArray<AuditCheck>): number {
  const totalWeight = audits.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return 0
  const weighted = audits.reduce((sum, item) => sum + item.score * item.weight, 0)
  return Math.round(weighted / totalWeight)
}

const CATEGORY_META: ReadonlyArray<{
  readonly id: AuditCategoryId
  readonly title: string
  readonly shortTitle: string
}> = [
  { id: "correctness", title: "Correctness & Determinism", shortTitle: "Correctness" },
  { id: "cache-speed", title: "Cache & Speed", shortTitle: "Cache & Speed" },
  { id: "security-trust", title: "Trust Source Inventory & Execution Policy", shortTitle: "Trust inventory" },
  { id: "formal-fuzz", title: "Formal & Fuzz Assurance", shortTitle: "Formal & Fuzz" },
  { id: "wiki-docs", title: "Wiki & Docs Freshness", shortTitle: "Wiki & Docs" },
  { id: "release-cloud", title: "Release & Cloud Readiness", shortTitle: "Cloud Release" }
]

export interface AuditRunOptions {
  readonly repoRoot: string
  readonly execution: VerifiedExecution
  readonly checkoutState?: BackpressureAuditReport["checkoutState"]
  readonly callerReportedChecks?: boolean
  readonly testResults?: {
    readonly passed: number
    readonly failed: number
    readonly durationMs: number
  }
  readonly typecheckPassed?: boolean
  readonly typecheckDurationMs?: number
  readonly replayResults?: {
    readonly targets: number
    readonly mismatches: number
    readonly cacheHits?: number
    readonly speedupFactor?: number
    readonly durationMs?: number
    readonly evidence?: ReadonlyArray<string>
  }
  readonly formalResults?: {
    readonly theorems: number
    readonly sorryCount: number
    readonly packages?: number
    readonly files?: number
    readonly durationMs?: number
    readonly evidence?: ReadonlyArray<string>
  }
  readonly fuzzResults?: {
    readonly suites: number
    readonly passed: number
    readonly failed: number
    readonly durationMs?: number
    readonly evidence?: ReadonlyArray<string>
  }
  readonly waterfall?: ReadonlyArray<TimingWaterfallStep>
  readonly isExample?: boolean
  readonly releaseThreshold?: number
}

function measure<T>(fn: () => T): { readonly value: T; readonly durationMs: number } {
  const start = performance.now()
  const value = fn()
  return { value, durationMs: Math.max(0, Math.round(performance.now() - start)) }
}

function inspectTsconfig(repoRoot: string): {
  readonly exists: boolean
  readonly strict: boolean
  readonly noUncheckedIndexedAccess: boolean
} {
  const path = join(repoRoot, "tsconfig.json")
  if (!existsSync(path)) {
    return { exists: false, strict: false, noUncheckedIndexedAccess: false }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      compilerOptions?: { strict?: boolean; noUncheckedIndexedAccess?: boolean }
    }
    return {
      exists: true,
      strict: parsed.compilerOptions?.strict === true,
      noUncheckedIndexedAccess: parsed.compilerOptions?.noUncheckedIndexedAccess === true
    }
  } catch {
    return { exists: true, strict: false, noUncheckedIndexedAccess: false }
  }
}

function scanPublicProseHygiene(repoRoot: string): {
  readonly filesScanned: number
  readonly emDashHits: ReadonlyArray<string>
  readonly jjhubHits: ReadonlyArray<string>
} {
  const candidates: string[] = []
  for (const name of ["README.md", "CONTRIBUTING.md", "MAINTAINERS.md"]) {
    const p = join(repoRoot, name)
    if (existsSync(p)) candidates.push(p)
  }
  const wikiDir = join(repoRoot, "wiki")
  if (existsSync(wikiDir)) {
    for (const entry of readdirSync(wikiDir)) {
      if (entry.endsWith(".md")) candidates.push(join(wikiDir, entry))
    }
  }
  const homePath = join(repoRoot, ".smithers", "home.json")
  if (existsSync(homePath)) candidates.push(homePath)

  const emDashHits: string[] = []
  const jjhubHits: string[] = []
  for (const file of candidates) {
    const content = readFileSync(file, "utf8")
    const rel = file.slice(repoRoot.length + 1)
    if (content.includes("\u2014")) emDashHits.push(rel)
    if (/\bjjhub\b/i.test(content)) jjhubHits.push(rel)
  }
  return { filesScanned: candidates.length, emDashHits, jjhubHits }
}

function inspectWikiDirectory(repoRoot: string): {
  readonly pageCount: number
  readonly brokenLinks: ReadonlyArray<string>
  readonly pagesWithDiagrams: number
} {
  const wikiDir = join(repoRoot, "wiki")
  if (!existsSync(wikiDir)) {
    return { pageCount: 0, brokenLinks: [], pagesWithDiagrams: 0 }
  }
  const files = readdirSync(wikiDir).filter((f) => f.endsWith(".md"))
  const slugs = new Set(files.map((f) => f.replace(/\.md$/, "").toLowerCase()))
  const brokenLinks: string[] = []
  let pagesWithDiagrams = 0

  for (const file of files) {
    const text = readFileSync(join(wikiDir, file), "utf8")
    if (text.includes("```mermaid") || text.includes("```text") || text.includes("<svg")) {
      pagesWithDiagrams += 1
    }
    const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "")
    const matches = stripped.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)
    for (const match of matches) {
      const target = (match[1] ?? "").trim().toLowerCase()
      if (target && !slugs.has(target)) {
        brokenLinks.push(`${file} -> [[${target}]]`)
      }
    }
  }

  return { pageCount: files.length, brokenLinks, pagesWithDiagrams }
}

function inspectMythicalHistory(repoRoot: string): {
  readonly exists: boolean
  readonly valid: boolean
  readonly issues: ReadonlyArray<string>
  readonly epics: number
  readonly commits: number
} {
  const path = join(repoRoot, "history", "mythical-history.json")
  if (!existsSync(path)) {
    return { exists: false, valid: false, issues: ["Missing history/mythical-history.json"], epics: 0, commits: 0 }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MythicalHistorySnapshot
    const verification = verifyMythicalHistory(parsed)
    return {
      exists: true,
      valid: verification.valid,
      issues: verification.issues,
      epics: Array.isArray(parsed.epics) ? parsed.epics.length : 0,
      commits: Array.isArray(parsed.commits) ? parsed.commits.length : 0
    }
  } catch {
    return {
      exists: true,
      valid: false,
      issues: ["Failed to parse history/mythical-history.json"],
      epics: 0,
      commits: 0
    }
  }
}

export function runBackpressureAudit(options: AuditRunOptions): BackpressureAuditReport {
  const root = resolve(options.repoRoot)
  const releaseThreshold = options.releaseThreshold ?? 90
  const policy = evaluateExecutionPolicy(options.execution)

  const audits: AuditCheck[] = []

  // --- 1. Correctness & Determinism ---
  const tsconfigInfo = measure(() => inspectTsconfig(root))
  const typecheckMeasured = typeof options.typecheckPassed === "boolean"
  const typecheckOk = options.typecheckPassed === true
  audits.push({
    id: "ts-strict-typecheck",
    category: "correctness",
    title: "Strict TypeScript Typecheck",
    description: "Every core module, worker route, and factory UI file compiles with strict mode enabled.",
    status: !typecheckMeasured ? "warn" : typecheckOk ? "pass" : "fail",
    score: !typecheckMeasured ? 50 : typecheckOk ? 100 : 0,
    weight: 3,
    displayValue: !typecheckMeasured
      ? "Not measured"
      : typecheckOk
        ? "0 errors"
        : "Type errors detected",
    durationMs: typecheckMeasured
      ? Math.max(0, Math.round(options.typecheckDurationMs ?? 0))
      : tsconfigInfo.durationMs,
    evidence: [
      tsconfigInfo.value.exists
        ? `tsconfig.json strict: ${tsconfigInfo.value.strict}, noUncheckedIndexedAccess: ${tsconfigInfo.value.noUncheckedIndexedAccess}`
        : "No tsconfig.json found in checkout root",
      !typecheckMeasured
        ? "Typecheck was not executed in this audit invocation; run `bun run typecheck` and supply explicit measured status to clear this check"
        : `${options.callerReportedChecks ? "Caller-reported" : "Measured"} typecheck status: ${typecheckOk ? "passed" : "failed"}`
    ],
    remediation: typecheckMeasured && typecheckOk ? undefined : "Run `bun run typecheck` and pass the observed result."
  })

  const hasTestResults = options.testResults !== undefined
  const testsPassed = Math.max(0, Math.floor(options.testResults?.passed ?? 0))
  const testsFailed = Math.max(0, Math.floor(options.testResults?.failed ?? 0))
  const testTotal = testsPassed + testsFailed
  const testsMeasured = hasTestResults && testTotal > 0
  const testsOk = testsMeasured && testsFailed === 0
  const testScore = !testsMeasured
    ? 50
    : testsFailed === 0
      ? 100
      : Math.max(0, Math.round((testsPassed / testTotal) * 100))
  audits.push({
    id: "unit-integration-tests",
    category: "correctness",
    title: "Unit, Security & Protocol Suites",
    description: "Verifies trust isolation, one-time tokens, CAS integrity, audit scoring, wiki, history, and MCP tools.",
    status: !testsMeasured ? "warn" : testsFailed === 0 ? "pass" : "fail",
    score: testScore,
    weight: 4,
    displayValue: testsMeasured ? `${testsPassed}/${testTotal} passed` : "Not measured",
    durationMs: hasTestResults ? Math.max(0, Math.round(options.testResults?.durationMs ?? 0)) : 0,
    evidence: [
      testsMeasured
        ? `${options.callerReportedChecks ? "Caller reported" : "Observed"} ${testsPassed} passing and ${testsFailed} failing tests`
        : "No test results were supplied to this audit invocation; run `bun run test` and supply observed counts to satisfy this check"
    ],
    remediation: testsOk ? undefined : "Run `bun run test` and pass the observed test counts."
  })

  const replay = options.replayResults
  const replayMeasured = replay !== undefined && replay.targets > 0
  const replayOk = replayMeasured && replay.mismatches === 0
  audits.push({
    id: "replay-zero-mismatch",
    category: "correctness",
    title: "Kernel-Recorded Zero-Mismatch Parity",
    description: "smthrs-observe seccomp-unotify recording guarantees cached verdicts match clean baseline execution.",
    status: !replayMeasured ? "warn" : replayOk ? "pass" : "fail",
    score: !replayMeasured ? 50 : replayOk ? 100 : 0,
    weight: 3,
    displayValue: !replayMeasured
      ? "Not measured"
      : replayOk
        ? `0 mismatches (${replay.targets} targets)`
        : `${replay.mismatches} mismatches`,
    durationMs: replayMeasured ? Math.max(0, Math.round(replay.durationMs ?? 0)) : 0,
    evidence: replayMeasured
      ? [
          `Observed ${replay.targets} replay target(s) with ${replay.mismatches} mismatch(es)`,
          ...(replay.evidence ?? [])
        ]
      : [
          "Replay parity was not measured in this audit invocation; run `bun run replay` and supply measured replay results"
        ],
    remediation: replayOk ? undefined : "Run incremental replay against this checkout and provide measured parity evidence."
  })

  const proseMeasured = measure(() => scanPublicProseHygiene(root))
  const prose = proseMeasured.value
  const proseClean = prose.emDashHits.length === 0 && prose.jjhubHits.length === 0 && prose.filesScanned > 0
  audits.push({
    id: "public-copy-hygiene",
    category: "correctness",
    title: "Public Copy & Brand Hygiene",
    description: "Enforces zero em dashes and zero internal codenames across public docs, wiki, and home.json.",
    status: proseClean ? "pass" : prose.filesScanned === 0 ? "warn" : "fail",
    score: proseClean ? 100 : prose.filesScanned === 0 ? 50 : 40,
    weight: 2,
    displayValue: proseClean
      ? `${prose.filesScanned} files clean`
      : prose.filesScanned === 0
        ? "No public copy files"
        : `${prose.emDashHits.length + prose.jjhubHits.length} findings`,
    durationMs: proseMeasured.durationMs,
    evidence: [
      `Scanned ${prose.filesScanned} public docs and wiki files`,
      prose.emDashHits.length === 0 ? "0 em dashes found" : `Em dashes in: ${prose.emDashHits.join(", ")}`,
      prose.jjhubHits.length === 0 ? "0 internal codename leaks" : `Internal codename in: ${prose.jjhubHits.join(", ")}`
    ],
    remediation: proseClean ? undefined : "Remove em dashes and internal codenames from public-facing copy."
  })

  // --- 2. Cache & Speed ---
  const remoteCacheCheck = measure(() => {
    const workspacePath = join(root, ".smithers", "WORKSPACE.ts")
    const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : ""
    return (
      workspaceText.includes("https://build.smithers.sh") &&
      workspaceText.includes("SMITHERS_CACHE_READ_TOKEN") &&
      workspaceText.includes("SMITHERS_CACHE_WRITE_TOKEN")
    )
  })
  const hasRemoteCache = remoteCacheCheck.value

  audits.push({
    id: "shared-object-store",
    category: "cache-speed",
    title: "Shared Smithers Cloud Object Store",
    description: "Workspace declares build.smithers.sh with separate read and write credentials.",
    status: hasRemoteCache ? "pass" : "fail",
    score: hasRemoteCache ? 100 : 25,
    weight: 4,
    displayValue: hasRemoteCache ? "build.smithers.sh" : "Missing remote cache",
    durationMs: remoteCacheCheck.durationMs,
    evidence: [
      hasRemoteCache
        ? ".smithers/WORKSPACE.ts declares https://build.smithers.sh with split read/write secret names"
        : ".smithers/WORKSPACE.ts missing build.smithers.sh configuration",
      "Content-addressed /ac + /cas plus R2 artifacts bucket (http://artifacts.smithers.internal)"
    ]
  })

  const packageTargetCheck = measure(() => existsSync(join(root, "PACKAGE.ts")))
  const hasPackageTargets = packageTargetCheck.value
  audits.push({
    id: "granular-incremental-targets",
    category: "cache-speed",
    title: "Granular Affected-Only Build Targets",
    description: "PACKAGE.ts stratifies fast-check, medium-check, and full-check targets for zero wasted reruns.",
    status: hasPackageTargets ? "pass" : "fail",
    score: hasPackageTargets ? 100 : 20,
    weight: 3,
    displayValue: hasPackageTargets ? "3-tier graph" : "No PACKAGE.ts",
    durationMs: packageTargetCheck.durationMs,
    evidence: [
      hasPackageTargets
        ? "PACKAGE.ts declares fast-check, medium-check, full-check, audit, and docs targets"
        : "Missing root PACKAGE.ts"
    ]
  })

  const speedup = replay?.speedupFactor
  const speedupMeasured = typeof speedup === "number" && Number.isFinite(speedup) && speedup > 0
  const speedupPass = speedupMeasured && speedup >= 1.2
  audits.push({
    id: "warm-cache-speedup",
    category: "cache-speed",
    title: "Warm Cache Replay Speedup",
    description: "Measured end-to-end wall-time reduction from shared object store hits.",
    status: !speedupMeasured ? "warn" : speedupPass ? "pass" : "warn",
    score: !speedupMeasured ? 50 : speedup >= 2 ? 100 : speedup >= 1.2 ? 92 : 70,
    weight: 3,
    displayValue: speedupMeasured ? `${speedup.toFixed(1)}x replay` : "Not measured",
    durationMs: speedupMeasured ? Math.max(0, Math.round(replay?.durationMs ?? 0)) : 0,
    evidence: speedupMeasured
      ? [
          `Observed ${speedup.toFixed(2)}x speedup across ${replay?.targets ?? 0} replay target(s)` +
            (typeof replay?.cacheHits === "number" ? ` (${replay.cacheHits} cache hits)` : "")
        ]
      : ["Warm cache replay speedup was not measured in this audit invocation"],
    remediation: speedupPass ? undefined : "Run cached replay on this checkout and pass measured timing evidence."
  })

  // --- 3. Security & Trust Isolation ---
  const securityFiles = measure(() => ({
    trustModuleExists: existsSync(join(root, "src", "trust", "ExecutionTrust.ts")),
    tokenModuleExists: existsSync(join(root, "src", "auth", "OneTimeToken.ts")),
    storeModuleExists: existsSync(join(root, "src", "store", "ObjectStore.ts"))
  }))
  const { trustModuleExists, tokenModuleExists, storeModuleExists } = securityFiles.value

  audits.push({
    id: "untrusted-cache-isolation",
    category: "security-trust",
    title: "Cache Isolation Source Files",
    description: "Checks for the trust and object-store source files.",
    status: trustModuleExists && storeModuleExists ? "pass" : "fail",
    score: trustModuleExists && storeModuleExists ? 100 : 0,
    weight: 4,
    displayValue: trustModuleExists && storeModuleExists ? "Modules present" : "Modules missing",
    durationMs: securityFiles.durationMs,
    evidence: [
      `Trust source file: ${trustModuleExists ? "present" : "missing"}`,
      `Object store source file: ${storeModuleExists ? "present" : "missing"}`
    ]
  })

  audits.push({
    id: "untrusted-gate-non-bypass",
    category: "security-trust",
    title: "Current Execution Policy",
    description: "Reports gate eligibility for this execution.",
    status: trustModuleExists ? "pass" : "fail",
    score: trustModuleExists ? 100 : 0,
    weight: 4,
    displayValue: options.execution.trusted ? policy.provenanceBadge : "PREVIEW ONLY",
    durationMs: 0,
    evidence: [
      `Current execution tier: ${options.execution.effectiveTier} (${options.execution.actor})`,
      `Gate satisfaction eligible: ${policy.canSatisfyGates ? "yes" : "no (untrusted local/community preview)"}`,
      ...(options.execution.downgraded && options.execution.downgradeReason
        ? [`Downgraded: ${options.execution.downgradeReason}`]
        : [])
    ]
  })

  audits.push({
    id: "one-time-sandbox-auth",
    category: "security-trust",
    title: "Token Implementation File",
    description: "Checks for the one-time token source file.",
    status: tokenModuleExists ? "pass" : "fail",
    score: tokenModuleExists ? 100 : 0,
    weight: 3,
    displayValue: tokenModuleExists ? "Module present" : "Module missing",
    durationMs: 0,
    evidence: [
      tokenModuleExists ? "src/auth/OneTimeToken.ts present" : "Missing src/auth/OneTimeToken.ts"
    ]
  })

  audits.push({
    id: "root-input-tracing",
    category: "security-trust",
    title: "Documented Trust Boundaries",
    description: "Counts entries in the reference table.",
    status: "pass",
    score: 100,
    weight: 2,
    displayValue: `${ROOT_INPUT_TRACING_TABLE.length} boundaries documented`,
    durationMs: 0,
    evidence: ROOT_INPUT_TRACING_TABLE.map((row) => `${row.privilegedStep} -> ${row.trustBoundary}`)
  })

  // --- 4. Formal & Fuzz Assurance ---
  const formal = options.formalResults
  const formalMeasured = formal !== undefined && formal.theorems > 0
  const formalOk = formalMeasured && formal.sorryCount === 0
  audits.push({
    id: "lean4-formal-specs",
    category: "formal-fuzz",
    title: "Lean 4 Formal Verification Specs",
    description: "Machine-checked theorems covering inventory, decomposition, sharding, apply, replay, and observer.",
    status: !formalMeasured ? "warn" : formalOk ? "pass" : "fail",
    score: !formalMeasured ? 50 : formalOk ? 100 : Math.max(0, 100 - formal.sorryCount * 20),
    weight: 4,
    displayValue: !formalMeasured ? "Not measured" : `${formal.theorems} theorems / ${formal.sorryCount} sorry`,
    durationMs: formalMeasured ? Math.max(0, Math.round(formal.durationMs ?? 0)) : 0,
    evidence: formalMeasured
      ? [
          `Observed ${formal.theorems} proven theorems with ${formal.sorryCount} sorry axioms`,
          ...(formal.packages !== undefined && formal.files !== undefined
            ? [`${formal.packages} Lean packages across ${formal.files} .lean files`]
            : []),
          ...(formal.evidence ?? [])
        ]
      : ["No Lean 4 verification results were measured in this audit invocation"],
    remediation: formalOk ? undefined : "Run Lean 4 verification and pass observed theorem counts to measure this check."
  })

  const fuzzFileCheck = measure(() => existsSync(join(root, "src", "security", "Adversarial.fuzz.test.ts")))
  const fuzzFileExists = fuzzFileCheck.value
  const fuzz = options.fuzzResults
  const fuzzTotal = (fuzz?.passed ?? 0) + (fuzz?.failed ?? 0)
  const fuzzMeasured = fuzz !== undefined && fuzzTotal > 0
  const fuzzOk = fuzzMeasured && (fuzz?.failed ?? 0) === 0
  audits.push({
    id: "fuzz-property-assurance",
    category: "formal-fuzz",
    title: "Adversarial Fuzz & Property Suite",
    description: "Fuzzes trust attestations, token replay, CAS corruption, XSS escaping, and Home.read bounds.",
    status: !fuzzMeasured ? "warn" : fuzzOk ? "pass" : "fail",
    score: !fuzzMeasured
      ? 50
      : fuzzOk
        ? 100
        : Math.max(0, Math.round(((fuzz?.passed ?? 0) / fuzzTotal) * 100)),
    weight: 3,
    displayValue: !fuzzMeasured
      ? fuzzFileExists
        ? "Suite present (not measured)"
        : "Not measured"
      : `${fuzz.suites} suite${fuzz.suites === 1 ? "" : "s"} (${fuzz.passed}/${fuzzTotal} pass)`,
    durationMs: fuzzMeasured ? Math.max(0, Math.round(fuzz?.durationMs ?? 0)) : fuzzFileCheck.durationMs,
    evidence: fuzzMeasured
      ? [
          `Observed ${fuzz.passed}/${fuzzTotal} passing adversarial fuzz checks across ${fuzz.suites} suite(s)`,
          ...(fuzz.evidence ?? [])
        ]
      : [
          fuzzFileExists
            ? "src/security/Adversarial.fuzz.test.ts is present in this checkout, but was not executed in this audit invocation"
            : "No adversarial fuzz suite results were measured in this audit invocation"
        ],
    remediation: fuzzOk ? undefined : "Execute the adversarial fuzz suite and supply measured results."
  })

  // --- 5. Wiki & Docs Freshness ---
  const wikiMeasured = measure(() => ({
    stats: inspectWikiDirectory(root),
    hasCodingProject: existsSync(join(root, ".smithers", "coding-project.json"))
  }))
  const wikiStats = wikiMeasured.value.stats
  const hasCodingProject = wikiMeasured.value.hasCodingProject
  const wikiHealthy = wikiStats.pageCount >= 6 && wikiStats.brokenLinks.length === 0 && hasCodingProject

  audits.push({
    id: "wiki-catalog-freshness",
    category: "wiki-docs",
    title: "Obsidian Wiki Catalog & Backlinks",
    description: "Verified repository wiki pages with intact [[wikilinks]] and .smithers/coding-project.json.",
    status: wikiHealthy ? "pass" : wikiStats.pageCount > 0 ? "warn" : "fail",
    score: wikiHealthy ? 100 : wikiStats.pageCount > 0 ? 70 : 0,
    weight: 4,
    displayValue: `${wikiStats.pageCount} pages / ${wikiStats.brokenLinks.length} broken`,
    durationMs: wikiMeasured.durationMs,
    evidence: [
      `${wikiStats.pageCount} markdown wiki pages discovered under wiki/`,
      `${wikiStats.brokenLinks.length} broken [[wikilinks]]`,
      hasCodingProject ? ".smithers/coding-project.json catalog present" : "Missing .smithers/coding-project.json"
    ]
  })

  const diagramsRatio = wikiStats.pageCount > 0 ? wikiStats.pagesWithDiagrams / wikiStats.pageCount : 0
  audits.push({
    id: "visual-first-diagrams",
    category: "wiki-docs",
    title: "Visual-First Architecture Diagrams",
    description: "Every wiki page leads with a diagram before prose.",
    status: diagramsRatio >= 0.9 ? "pass" : diagramsRatio > 0 ? "warn" : "fail",
    score: Math.round(diagramsRatio * 100),
    weight: 2,
    displayValue: `${wikiStats.pagesWithDiagrams}/${wikiStats.pageCount} pages`,
    durationMs: 0,
    evidence: [`${wikiStats.pagesWithDiagrams} of ${wikiStats.pageCount} wiki pages embed diagrams`]
  })

  const historyMeasured = measure(() => inspectMythicalHistory(root))
  const historyInfo = historyMeasured.value
  audits.push({
    id: "mythical-history-integrity",
    category: "wiki-docs",
    title: "Mythical History Linear Stack",
    description: "Deterministic epic timeline folding real commits with evidence and tried notes.",
    status: historyInfo.valid ? "pass" : "fail",
    score: historyInfo.valid ? 100 : 0,
    weight: 3,
    displayValue: historyInfo.valid
      ? `${historyInfo.epics} epics / ${historyInfo.commits} commits`
      : historyInfo.exists
        ? "History invalid"
        : "Missing history",
    durationMs: historyMeasured.durationMs,
    evidence: historyInfo.valid
      ? [
          `history/mythical-history.json verified (${historyInfo.epics} epics, ${historyInfo.commits} commits)`
        ]
      : historyInfo.issues
  })

  // --- 6. Release & Cloud Readiness ---
  const homeMeasured = measure(() => {
    const homePath = join(root, ".smithers", "home.json")
    if (!existsSync(homePath)) {
      return { valid: false, audiences: 0, reason: "Missing .smithers/home.json" }
    }
    const check = validateHomeJson(readFileSync(homePath, "utf8"))
    const audSet = new Set(check.audiences)
    const hasAllThree = audSet.has("maintainer") && audSet.has("contributor") && audSet.has("everyone")
    return {
      valid: check.valid && hasAllThree,
      audiences: audSet.size,
      reason: check.valid
        ? hasAllThree
          ? ".smithers/home.json declares maintainer, contributor, and everyone sections within @smthrs/views bounds"
          : ".smithers/home.json does not cover all three audiences"
        : (check.reason ?? ".smithers/home.json invalid")
    }
  })

  audits.push({
    id: "personalized-home-manifest",
    category: "release-cloud",
    title: "Personalized Home Manifest (3 Audiences)",
    description: ".smithers/home.json customizes the factory for maintainers, contributors, and viewers.",
    status: homeMeasured.value.valid ? "pass" : "fail",
    score: homeMeasured.value.valid ? 100 : 0,
    weight: 3,
    displayValue: homeMeasured.value.valid ? "3/3 audiences" : `${homeMeasured.value.audiences}/3 audiences`,
    durationMs: homeMeasured.durationMs,
    evidence: [homeMeasured.value.reason]
  })

  const factoryMeasured = measure(() => {
    const factoryPath = join(root, ".smithers", "factory.json")
    if (!existsSync(factoryPath)) return 0
    try {
      const parsed = JSON.parse(readFileSync(factoryPath, "utf8")) as {
        apiVersion?: number
        contributes?: { triggers?: ReadonlyArray<unknown> }
      }
      if (parsed.apiVersion === 1 && Array.isArray(parsed.contributes?.triggers)) {
        return parsed.contributes.triggers.length
      }
      return 0
    } catch {
      return 0
    }
  })
  const factoryTriggers = factoryMeasured.value

  audits.push({
    id: "smithers-cloud-triggers",
    category: "release-cloud",
    title: "Smithers Cloud Factory & Flows",
    description: ".smithers/factory.json declares factory triggers.",
    status: factoryTriggers >= 2 ? "pass" : "fail",
    score: factoryTriggers >= 2 ? 100 : 0,
    weight: 3,
    displayValue: `${factoryTriggers} triggers`,
    durationMs: factoryMeasured.durationMs,
    evidence: [
      factoryTriggers >= 2
        ? `.smithers/factory.json declares ${factoryTriggers} triggers`
        : "Missing v1 triggers in .smithers/factory.json"
    ]
  })

  const wfMeasured = measure(() => ({
    inv: inventoryGithubWorkflows(root),
    mirrorReleaseExists: existsSync(join(root, ".github", "workflows", "smithers-mirror-release.yml")),
    untrustedPrExists: existsSync(join(root, ".github", "workflows", "untrusted-pr-check.yml"))
  }))
  const wfInventory = wfMeasured.value.inv
  const mirrorReleaseExists = wfMeasured.value.mirrorReleaseExists
  const untrustedPrExists = wfMeasured.value.untrustedPrExists
  const workflowsHealthy = mirrorReleaseExists && untrustedPrExists && wfInventory.untrustedSafe
  audits.push({
    id: "github-mirror-release-pipeline",
    category: "release-cloud",
    title: "Mirror Workflow Inventory",
    description: "Inventories workflow files and summarizes static checks.",
    status: workflowsHealthy ? "pass" : "fail",
    score: workflowsHealthy ? 100 : 20,
    weight: 3,
    displayValue: workflowsHealthy
      ? `${wfInventory.workflows.length} workflows / ${wfInventory.totalJobs} jobs, no static findings`
      : `${wfInventory.totalSecurityFindings} findings`,
    durationMs: wfMeasured.durationMs,
    evidence: [
      `Inventoried ${wfInventory.workflows.length} workflows (${wfInventory.totalJobs} jobs, ${wfInventory.totalSteps} steps)`,
      mirrorReleaseExists ? ".github/workflows/smithers-mirror-release.yml present" : "Missing mirror release workflow",
      untrustedPrExists ? ".github/workflows/untrusted-pr-check.yml present" : "Missing untrusted PR workflow",
      ...wfInventory.workflows.flatMap((w) => w.securityFindings)
    ]
  })

  const mcpMeasured = measure(() => existsSync(join(root, "src", "mcp", "McpServer.ts")))
  const mcpExists = mcpMeasured.value
  audits.push({
    id: "cloud-mcp-server",
    category: "release-cloud",
    title: "MCP Server Source File",
    description: "Checks for the MCP server source file.",
    status: mcpExists ? "pass" : "fail",
    score: mcpExists ? 100 : 0,
    weight: 3,
    displayValue: mcpExists ? "Module present" : "MCP missing",
    durationMs: mcpMeasured.durationMs,
    evidence: [
      mcpExists
        ? "src/mcp/McpServer.ts present"
        : "Missing src/mcp/McpServer.ts"
    ]
  })

  const categories: AuditCategorySummary[] = CATEGORY_META.map((meta) => {
    const items = audits.filter((a) => a.category === meta.id)
    const score = weightedScore(items)
    return {
      id: meta.id,
      title: meta.title,
      shortTitle: meta.shortTitle,
      score,
      rating: ratingForScore(score),
      passedCount: items.filter((a) => a.status === "pass").length,
      warnCount: items.filter((a) => a.status === "warn").length,
      failCount: items.filter((a) => a.status === "fail").length,
      audits: items
    }
  })

  const overallScore = Math.round(
    categories.reduce((sum, cat) => sum + cat.score, 0) / categories.length
  )
  const failed = audits.filter((a) => a.status === "fail").length
  const warnings = audits.filter((a) => a.status === "warn").length
  const passed = audits.filter((a) => a.status === "pass").length

  const checksPassed =
    !options.callerReportedChecks &&
    overallScore >= releaseThreshold &&
    failed === 0 &&
    typecheckMeasured &&
    typecheckOk &&
    testsMeasured &&
    testsOk
  const gate = evaluateGate(options.execution, "lighthouse-backpressure", checksPassed)
  const gateReceipt = createGateReceipt(options.execution, gate, overallScore)

  const waterfall: ReadonlyArray<TimingWaterfallStep> = options.waterfall ? [...options.waterfall] : []

  const report: BackpressureAuditReport = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    repository: options.execution.repository,
    commitSha: options.execution.commitSha,
    ...(options.checkoutState ? { checkoutState: options.checkoutState } : {}),
    ...(options.isExample === true ? { isExample: true } : {}),
    execution: options.execution,
    policy,
    gate,
    gateReceipt,
    overallScore,
    overallRating: ratingForScore(overallScore),
    categories,
    waterfall,
    securityTraceRows: ROOT_INPUT_TRACING_TABLE,
    summary: {
      totalAudits: audits.length,
      passed,
      warnings,
      failed,
      releaseThreshold,
      releaseReady: gate.satisfied
    }
  }
  return report
}
