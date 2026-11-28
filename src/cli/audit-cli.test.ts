import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { BackpressureAuditReport } from "../audit/AuditEngine.ts"
import { EXAMPLE_COMMIT_SHA } from "../audit/ExampleAudit.ts"
import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"
import { type ExternalTrustReceiptAdapter, resolveCliExecutionTrust } from "../trust/TrustReceipt.ts"
import { parseRepositorySlug, resolveCheckoutIdentity } from "./CheckoutIdentity.ts"
import { runCli } from "./main.ts"

const REPO_ROOT = resolve(process.cwd())
const CLI_ENTRY = join(REPO_ROOT, "bin", "smithers-ci.mjs")
const SOURCE_COMMIT = "268dbdf0aadc1e633ebeeee543d5ea75fefcf647"
const PACKED_COMMIT = "11223344556677889900aabbccddeeff00112233"

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function cleanCliEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.SMITHERS_COMMIT_SHA
  delete env.GITHUB_SHA
  delete env.SMITHERS_CONTROL_SECRET
  delete env.SMITHERS_TRUST_RECEIPT
  delete env.SMITHERS_REPOSITORY
  delete env.GITHUB_REPOSITORY
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

function runRealCli(
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}
) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI_ENTRY, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? cleanCliEnv(),
    encoding: "utf8",
    timeout: 15_000
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("Normal CLI Audit & Trust Provenance (real bin/smithers-ci.mjs entry point)", () => {
  it("defaults ordinary audit to actual checkout identity, honest UNTRUSTED COMMUNITY provenance, and zero invented counts", () => {
    const outDir = makeTempDir("smithers-cli-audit-out-")
    const expectedCheckout = resolveCheckoutIdentity(REPO_ROOT, cleanCliEnv())
    expect(expectedCheckout.commitVerified).toBe(true)
    expect(expectedCheckout.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(expectedCheckout.commitSha).not.toBe(EXAMPLE_COMMIT_SHA)
    expect(expectedCheckout.repository).toBe("smithersai/smithers-ci")

    const res = runRealCli(["audit", "--out", outDir])
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain("UNTRUSTED COMMUNITY")
    expect(res.stdout).toContain(expectedCheckout.commitSha)
    expect(res.stdout).toContain("Gate: untrusted_preview (NOT SATISFIED)")
    expect(res.stdout).not.toContain("TRUSTED SANDBOX")
    expect(res.stdout).not.toContain("(SATISFIED)")
    expect(res.stdout).not.toContain(EXAMPLE_COMMIT_SHA)
    expect(res.stdout).not.toContain("cfbox-local")
    expect(res.stdout).not.toContain("roninjin10")

    const jsonText = readFileSync(join(outDir, "lighthouse-audit.json"), "utf8")
    const htmlText = readFileSync(join(outDir, "lighthouse-audit.html"), "utf8")
    const report = JSON.parse(jsonText) as BackpressureAuditReport

    expect(report.repository).toBe("smithersai/smithers-ci")
    expect(report.commitSha).toBe(expectedCheckout.commitSha)
    expect(report.isExample).toBeUndefined()
    expect(report.execution.effectiveTier).toBe("untrusted:community")
    expect(report.execution.trusted).toBe(false)
    expect(report.execution.sandboxId).toBeNull()
    expect(report.policy.provenanceBadge).toBe("UNTRUSTED COMMUNITY")
    expect(report.policy.allowCacheWrite).toBe(false)
    expect(report.policy.allowTrustedArtifactWrite).toBe(false)
    expect(report.policy.canSatisfyGates).toBe(false)
    expect(report.gate.status).toBe("untrusted_preview")
    expect(report.gate.satisfied).toBe(false)
    expect(report.gate.passed).toBe(false)
    expect(report.gateReceipt.satisfied).toBe(false)
    expect(report.gateReceipt.trustTier).toBe("untrusted:community")
    expect(report.gateReceipt.commitSha).toBe(expectedCheckout.commitSha)
    expect(report.summary.releaseReady).toBe(false)
    expect(report.waterfall).toEqual([])

    const allAudits = report.categories.flatMap((c) => c.audits)
    for (const unmeasuredId of [
      "ts-strict-typecheck",
      "unit-integration-tests",
      "replay-zero-mismatch",
      "warm-cache-speedup",
      "lean4-formal-specs",
      "fuzz-property-assurance"
    ]) {
      const check = allAudits.find((a) => a.id === unmeasuredId)
      expect(check, `missing audit ${unmeasuredId}`).toBeDefined()
      expect(check?.status, `${unmeasuredId} should stay warn when unmeasured`).toBe("warn")
    }

    for (const fabricated of [
      EXAMPLE_COMMIT_SHA,
      "387 theorems",
      "40+ fuzz suites",
      "4.4x docs",
      "36/36 passed",
      "elizaOS",
      "cfbox-local",
      "TRUSTED SANDBOX"
    ]) {
      expect(jsonText).not.toContain(fabricated)
      expect(htmlText).not.toContain(fabricated)
    }

    expect(htmlText).toContain("Content-Security-Policy")
    expect(htmlText).toContain("UNTRUSTED COMMUNITY")
    expect(htmlText).toContain("NOT SATISFIED")
    expect(htmlText).toContain(expectedCheckout.commitSha.slice(0, 12))
  })

  it("resolves pure .git checkouts (detached HEAD, packed-refs, worktrees) without jj or git CLI and isolates untrusted object store writes", () => {
    const detachedRepo = makeTempDir("smithers-git-detached-")
    mkdirSync(join(detachedRepo, ".git"), { recursive: true })
    writeFileSync(join(detachedRepo, ".git", "HEAD"), `${SOURCE_COMMIT}\n`, "utf8")
    writeFileSync(
      join(detachedRepo, ".git", "config"),
      '[remote "origin"]\n\turl = https://bot:secret-token-should-not-leak@github.com/smithersai/smithers-ci.git\n',
      "utf8"
    )

    const nodeOnlyPath = dirname(process.execPath)
    const env = cleanCliEnv({ PATH: nodeOnlyPath, USER: "sandbox-runner" })
    const outDir = join(detachedRepo, ".smithers", "reports")
    const res = runRealCli(["audit", "--out", outDir], { cwd: detachedRepo, env })
    expect([0, 1]).toContain(res.status)
    expect(res.stdout).toContain("UNTRUSTED COMMUNITY")
    expect(res.stdout).toContain(SOURCE_COMMIT)
    expect(res.stdout).not.toContain("TRUSTED SANDBOX")
    expect(res.stdout).not.toContain("secret-token-should-not-leak")
    expect(res.stderr).not.toContain("secret-token-should-not-leak")

    const reportText = readFileSync(join(outDir, "lighthouse-audit.json"), "utf8")
    expect(reportText).not.toContain("secret-token-should-not-leak")
    const report = JSON.parse(reportText) as BackpressureAuditReport
    expect(report.repository).toBe("smithersai/smithers-ci")
    expect(report.commitSha).toBe(SOURCE_COMMIT)
    expect(report.execution.trusted).toBe(false)
    expect(report.gate.satisfied).toBe(false)

    const storeRoot = join(detachedRepo, ".smithers", "object-store")
    expect(readdirSync(join(storeRoot, "cas"))).toHaveLength(0)
    expect(readdirSync(join(storeRoot, "ac"))).toHaveLength(0)
    expect(readdirSync(join(storeRoot, "untrusted-cas")).length).toBeGreaterThanOrEqual(2)
    const index = JSON.parse(readFileSync(join(storeRoot, "artifacts-index.json"), "utf8")) as Array<{
      key: string
      trusted: boolean
      commitSha: string
    }>
    expect(index.length).toBe(2)
    for (const item of index) {
      expect(item.trusted).toBe(false)
      expect(item.key).toMatch(new RegExp(`^untrusted/sandbox-runner/${SOURCE_COMMIT}/`))
      expect(item.commitSha).toBe(SOURCE_COMMIT)
    }

    const packedRepo = makeTempDir("smithers-git-packed-")
    mkdirSync(join(packedRepo, ".git"), { recursive: true })
    writeFileSync(join(packedRepo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8")
    writeFileSync(
      join(packedRepo, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled\n${PACKED_COMMIT} refs/heads/main\n`,
      "utf8"
    )
    const packedId = resolveCheckoutIdentity(packedRepo, env)
    expect(packedId.commitSha).toBe(PACKED_COMMIT)
    expect(packedId.commitSource).toBe("git")
    expect(packedId.commitVerified).toBe(true)
    expect(packedId.ref).toBe("refs/heads/main")

    const mainGitDir = makeTempDir("smithers-git-common-")
    const wtGitDir = join(mainGitDir, "worktrees", "wt1")
    const wtCheckout = makeTempDir("smithers-git-worktree-")
    mkdirSync(join(mainGitDir, "refs", "heads"), { recursive: true })
    mkdirSync(wtGitDir, { recursive: true })
    writeFileSync(join(mainGitDir, "refs", "heads", "feature"), `${SOURCE_COMMIT}\n`, "utf8")
    writeFileSync(
      join(mainGitDir, "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/widget-ci.git\n',
      "utf8"
    )
    writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8")
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/feature\n", "utf8")
    writeFileSync(join(wtCheckout, ".git"), `gitdir: ${wtGitDir}\n`, "utf8")

    const wtId = resolveCheckoutIdentity(wtCheckout, env)
    expect(wtId.commitSha).toBe(SOURCE_COMMIT)
    expect(wtId.commitVerified).toBe(true)
    expect(wtId.repository).toBe("acme/widget-ci")
    expect(wtId.repositorySource).toBe("git-config")

    expect(parseRepositorySlug("https://user:pass@github.com/Org/Repo.git")).toBe("org/repo")
    expect(parseRepositorySlug("git@github.com:SmithersAI/smithers-ci.git")).toBe("smithersai/smithers-ci")
    expect(parseRepositorySlug("not-a-repo")).toBeNull()
  })

  it("never falls back to a fixed example commit in a non-VCS directory", () => {
    const plainDir = makeTempDir("smithers-no-vcs-")
    const outDir = join(plainDir, "out")
    const res = runRealCli(["audit", "--out", outDir], { cwd: plainDir, env: cleanCliEnv() })
    expect([0, 1]).toContain(res.status)

    const report = JSON.parse(readFileSync(join(outDir, "lighthouse-audit.json"), "utf8")) as BackpressureAuditReport
    expect(report.commitSha).toBe("uncommitted-workspace")
    expect(report.commitSha).not.toBe(EXAMPLE_COMMIT_SHA)
    expect(report.repository.startsWith("local/")).toBe(true)
    expect(report.policy.artifactNamespace).toMatch(/^untrusted\/[^/]+\/workspace$/)
    expect(report.gate.satisfied).toBe(false)
  })

  it("preserves honest untrusted compatibility, ignores ambient SMITHERS_CONTROL_SECRET, and prefers actual checkout commit over mismatched env SHA", () => {
    const outDir1 = makeTempDir("smithers-untrusted-compat-")
    const compat = runRealCli(["audit", "--trust", "untrusted:community", "--out", outDir1])
    expect(compat.status, compat.stderr).toBe(0)
    const compatReport = JSON.parse(
      readFileSync(join(outDir1, "lighthouse-audit.json"), "utf8")
    ) as BackpressureAuditReport
    expect(compatReport.execution.effectiveTier).toBe("untrusted:community")
    expect(compatReport.gate.satisfied).toBe(false)

    const outDir2 = makeTempDir("smithers-ambient-secret-")
    const secretVal = "ambient-secret-never-elevate-or-echo-0123456789"
    const ambient = runRealCli(["audit", "--out", outDir2], {
      env: cleanCliEnv({ SMITHERS_CONTROL_SECRET: secretVal, SMITHERS_COMMIT_SHA: EXAMPLE_COMMIT_SHA })
    })
    expect(ambient.status, ambient.stderr).toBe(0)
    expect(ambient.stdout).toContain("UNTRUSTED COMMUNITY")
    expect(ambient.stdout).not.toContain("TRUSTED SANDBOX")
    expect(ambient.stdout).not.toContain(secretVal)
    expect(ambient.stderr).not.toContain(secretVal)
    expect(ambient.stderr).toContain("disagrees with checkout commit")

    const ambientJson = readFileSync(join(outDir2, "lighthouse-audit.json"), "utf8")
    const ambientHtml = readFileSync(join(outDir2, "lighthouse-audit.html"), "utf8")
    expect(ambientJson).not.toContain(secretVal)
    expect(ambientHtml).not.toContain(secretVal)
    const ambientReport = JSON.parse(ambientJson) as BackpressureAuditReport
    expect(ambientReport.execution.trusted).toBe(false)
    expect(ambientReport.gate.satisfied).toBe(false)
    expect(ambientReport.commitSha).not.toBe(EXAMPLE_COMMIT_SHA)
  })

  it("fails closed on any elevated provenance request without a production external trust-receipt adapter and writes no artifacts", () => {
    const cases: ReadonlyArray<{
      readonly label: string
      readonly args: ReadonlyArray<string>
      readonly env?: NodeJS.ProcessEnv
      readonly expectedExit: number
      readonly expectedStderr: RegExp
    }> = [
      {
        label: "--trust trusted:sandbox",
        args: ["audit", "--trust", "trusted:sandbox"],
        expectedExit: 1,
        expectedStderr: /external.*trust.?receipt.*adapter/i
      },
      {
        label: "--trust=trusted:sandbox",
        args: ["audit", "--trust=trusted:sandbox"],
        expectedExit: 1,
        expectedStderr: /Missing integration/i
      },
      {
        label: "--trust trusted:maintainer",
        args: ["audit", "--trust", "trusted:maintainer"],
        expectedExit: 1,
        expectedStderr: /Missing integration/i
      },
      {
        label: "--trust trusted:sandbox with ambient SMITHERS_CONTROL_SECRET",
        args: ["audit", "--trust", "trusted:sandbox"],
        env: cleanCliEnv({ SMITHERS_CONTROL_SECRET: "secret-that-must-not-self-sign-999999" }),
        expectedExit: 1,
        expectedStderr: /Local self-signing and ambient environment secrets/i
      },
      {
        label: "--trust-receipt file",
        args: ["audit", "--trust-receipt", "/tmp/nonexistent-receipt.json"],
        expectedExit: 1,
        expectedStderr: /Missing integration/i
      },
      {
        label: "SMITHERS_TRUST_RECEIPT env",
        args: ["audit"],
        env: cleanCliEnv({ SMITHERS_TRUST_RECEIPT: "/tmp/nonexistent-receipt.json" }),
        expectedExit: 1,
        expectedStderr: /Missing integration/i
      },
      {
        label: "invalid trust tier",
        args: ["audit", "--trust", "trusted:root"],
        expectedExit: 1,
        expectedStderr: /Unsupported trust tier/i
      },
      {
        label: "missing flag value for --trust",
        args: ["audit", "--trust"],
        expectedExit: 2,
        expectedStderr: /Missing value for --trust/i
      },
      {
        label: "invalid --typecheck-passed value",
        args: ["audit", "--typecheck-passed", "maybe"],
        expectedExit: 2,
        expectedStderr: /Invalid value for --typecheck-passed/i
      },
      {
        label: "negative --tests-passed value",
        args: ["audit", "--tests-passed", "-5"],
        expectedExit: 2,
        expectedStderr: /Invalid value for --tests-passed/i
      }
    ]

    for (const tc of cases) {
      const workDir = makeTempDir("smithers-fail-closed-")
      mkdirSync(join(workDir, ".git"), { recursive: true })
      writeFileSync(join(workDir, ".git", "HEAD"), `${SOURCE_COMMIT}\n`, "utf8")
      const outDir = join(workDir, "reports")

      const res = runRealCli([...tc.args, "--out", outDir], {
        cwd: workDir,
        env: tc.env ?? cleanCliEnv()
      })
      expect(res.status, `case ${tc.label}`).toBe(tc.expectedExit)
      expect(res.stderr, `case ${tc.label}`).toMatch(tc.expectedStderr)
      expect(res.stdout, `case ${tc.label}`).not.toContain("secret-that-must-not-self-sign-999999")
      expect(res.stderr, `case ${tc.label}`).not.toContain("secret-that-must-not-self-sign-999999")
      expect(existsSync(join(outDir, "lighthouse-audit.json")), `case ${tc.label} must not write JSON`).toBe(false)
      expect(existsSync(join(outDir, "lighthouse-audit.html")), `case ${tc.label} must not write HTML`).toBe(false)
      expect(existsSync(join(workDir, ".smithers", "object-store")), `case ${tc.label} must not write store`).toBe(false)
    }
  })

  it("uses actual checkout identity and fail-closed elevation in replay CLI as well", () => {
    const expectedCheckout = resolveCheckoutIdentity(REPO_ROOT, cleanCliEnv())
    const replayOk = runRealCli(["replay", "--json"], {
      env: cleanCliEnv({ SMITHERS_CONTROL_SECRET: "must-not-self-sign-replay-0123456789" })
    })
    expect(replayOk.status, replayOk.stderr).toBe(0)
    const report = JSON.parse(replayOk.stdout) as {
      commitSha: string
      trustTier: string
      provenanceBadge: string
      cacheWritesPerformed: number
    }
    expect(report.commitSha).toBe(expectedCheckout.commitSha)
    expect(report.commitSha).not.toBe(EXAMPLE_COMMIT_SHA)
    expect(report.trustTier).toBe("untrusted:community")
    expect(report.provenanceBadge).toBe("UNTRUSTED COMMUNITY")
    expect(report.cacheWritesPerformed).toBe(0)

    const replayBlocked = runRealCli(["replay", "--trust", "trusted:sandbox"])
    expect(replayBlocked.status).toBe(1)
    expect(replayBlocked.stderr).toMatch(/Missing integration/i)
  })

  it("enforces checkout binding and no tier widening when an external trust-receipt adapter is injected", async () => {
    const repoDir = makeTempDir("smithers-adapter-contract-")
    mkdirSync(join(repoDir, ".git"), { recursive: true })
    writeFileSync(join(repoDir, ".git", "HEAD"), `${SOURCE_COMMIT}\n`, "utf8")
    writeFileSync(
      join(repoDir, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/smithersai/smithers-ci.git\n',
      "utf8"
    )
    const receiptFile = join(repoDir, "receipt.json")
    writeFileSync(receiptFile, '{"type":"external-receipt"}\n', "utf8")
    const outDir = join(repoDir, "out")

    const secret = "external-verifier-test-only-key-0123456789"
    const now = new Date("2026-11-27T12:00:00.000Z")
    const makeVerified = (overrides: {
      tier?: "trusted:sandbox" | "trusted:maintainer"
      repository?: string
      commitSha?: string
    } = {}) => {
      const tier = overrides.tier ?? "trusted:sandbox"
      return verifyExecutionTrust(
        signExecutionClaim(
          {
            tier,
            callerKind: tier === "trusted:maintainer" ? "person" : "sandbox",
            actor: tier === "trusted:maintainer" ? "roninjin10" : "cfbox-verified-01",
            repository: overrides.repository ?? "smithersai/smithers-ci",
            commitSha: overrides.commitSha ?? SOURCE_COMMIT,
            sandboxId: tier === "trusted:sandbox" ? "cfbox-verified-01" : null,
            issuedAt: "2026-11-27T11:55:00.000Z",
            expiresAt: "2026-11-27T12:30:00.000Z"
          },
          secret
        ),
        { signingSecret: secret, now: () => now }
      )
    }

    const baseEnv = cleanCliEnv({ PATH: dirname(process.execPath) })

    const mismatchedCommitAdapter: ExternalTrustReceiptAdapter = {
      id: "test-external-verifier",
      verifyReceipt: () => ({
        ok: true,
        adapterId: "test-external-verifier",
        execution: makeVerified({ commitSha: PACKED_COMMIT })
      })
    }
    expect(
      await runCli(["audit", "--trust", "trusted:sandbox", "--trust-receipt", receiptFile, "--out", outDir], repoDir, {
        trustReceiptAdapter: mismatchedCommitAdapter,
        env: baseEnv,
        now: () => now
      })
    ).toBe(1)
    expect(existsSync(join(outDir, "lighthouse-audit.json"))).toBe(false)

    const wideningAdapter: ExternalTrustReceiptAdapter = {
      id: "test-external-verifier",
      verifyReceipt: () => ({
        ok: true,
        adapterId: "test-external-verifier",
        execution: makeVerified({ tier: "trusted:maintainer" })
      })
    }
    expect(
      await runCli(["audit", "--trust", "trusted:sandbox", "--trust-receipt", receiptFile, "--out", outDir], repoDir, {
        trustReceiptAdapter: wideningAdapter,
        env: baseEnv,
        now: () => now
      })
    ).toBe(1)

    const validAdapter: ExternalTrustReceiptAdapter = {
      id: "test-external-verifier",
      verifyReceipt: () => ({
        ok: true,
        adapterId: "test-external-verifier",
        execution: makeVerified()
      })
    }
    expect(
      await runCli(["audit", "--trust", "trusted:sandbox", "--out", outDir], repoDir, {
        trustReceiptAdapter: validAdapter,
        env: baseEnv,
        now: () => now
      })
    ).toBe(1)

    const code = await runCli(
      ["audit", "--trust", "trusted:sandbox", "--trust-receipt", receiptFile, "--out", outDir],
      repoDir,
      {
        trustReceiptAdapter: validAdapter,
        env: baseEnv,
        now: () => now
      }
    )
    expect([0, 1]).toContain(code)
    const report = JSON.parse(readFileSync(join(outDir, "lighthouse-audit.json"), "utf8")) as BackpressureAuditReport
    expect(report.execution.trusted).toBe(true)
    expect(report.execution.effectiveTier).toBe("trusted:sandbox")
    expect(report.commitSha).toBe(SOURCE_COMMIT)
    expect(report.gate.satisfied).toBe(false)
    expect(report.summary.releaseReady).toBe(false)
  })
  it("records explicit caller-supplied measurements without inventing durations and still keeps untrusted gates unsatisfied", () => {
    const outDir = makeTempDir("smithers-cli-measured-")
    const okRes = runRealCli([
      "audit",
      "--out",
      outDir,
      "--typecheck-passed",
      "true",
      "--tests-passed",
      "44",
      "--tests-failed",
      "0"
    ])
    expect(okRes.status, okRes.stderr).toBe(0)
    const okReport = JSON.parse(readFileSync(join(outDir, "lighthouse-audit.json"), "utf8")) as BackpressureAuditReport
    const tc = okReport.categories[0]!.audits.find((a) => a.id === "ts-strict-typecheck")
    const tests = okReport.categories[0]!.audits.find((a) => a.id === "unit-integration-tests")
    expect(tc?.status).toBe("pass")
    expect(tests?.status).toBe("pass")
    expect(tests?.displayValue).toBe("44/44 passed")
    expect(tests?.durationMs).toBe(0)
    expect(okReport.execution.trusted).toBe(false)
    expect(okReport.gate.satisfied).toBe(false)
    expect(okReport.gate.status).toBe("untrusted_preview")

    const failOut = makeTempDir("smithers-cli-typecheck-fail-")
    const failRes = runRealCli(["audit", "--out", failOut, "--typecheck-passed", "false"])
    expect(failRes.status).toBe(1)
    const failReport = JSON.parse(
      readFileSync(join(failOut, "lighthouse-audit.json"), "utf8")
    ) as BackpressureAuditReport
    expect(failReport.summary.failed).toBe(1)
    expect(failReport.gate.satisfied).toBe(false)
  })

  it("never invokes the git CLI even when resolving a .git-only checkout", () => {
    const repoDir = makeTempDir("smithers-no-git-cli-")
    const fakeBin = makeTempDir("smithers-fake-git-bin-")
    mkdirSync(join(repoDir, ".git"), { recursive: true })
    writeFileSync(join(repoDir, ".git", "HEAD"), `${SOURCE_COMMIT}\n`, "utf8")
    writeFileSync(
      join(repoDir, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/smithersai/smithers-ci.git\n',
      "utf8"
    )
    const markerFile = join(fakeBin, "git-was-invoked")
    const fakeGit = join(fakeBin, "git")
    writeFileSync(fakeGit, `#!/bin/sh\necho invoked > "${markerFile}"\nexit 99\n`, { mode: 0o755 })

    const env = cleanCliEnv({ PATH: `${fakeBin}:${dirname(process.execPath)}` })
    const outDir = join(repoDir, "out")
    const res = runRealCli(["audit", "--out", outDir], { cwd: repoDir, env })
    expect([0, 1]).toContain(res.status)
    expect(existsSync(markerFile)).toBe(false)

    const report = JSON.parse(readFileSync(join(outDir, "lighthouse-audit.json"), "utf8")) as BackpressureAuditReport
    expect(report.commitSha).toBe(SOURCE_COMMIT)
    expect(report.repository).toBe("smithersai/smithers-ci")
  })


  it("rejects elevation in resolveCliExecutionTrust when checkout is dirty, unverified, or has mismatched env SHA", async () => {
    const dummyAdapter: ExternalTrustReceiptAdapter = {
      id: "dummy",
      verifyReceipt: () => ({ ok: false, code: "receipt_rejected", message: "should not be reached" })
    }

    const dirtyRes = await resolveCliExecutionTrust({
      checkout: {
        repository: "smithersai/smithers-ci",
        repositorySource: "jj-remote",
        commitSha: SOURCE_COMMIT,
        commitSource: "jj",
        commitVerified: true,
        dirty: true,
        ref: null,
        envCommitMismatch: null
      },
      requestedTier: "trusted:sandbox",
      receiptPath: "/tmp/receipt.json",
      adapter: dummyAdapter
    })
    expect(dirtyRes.ok).toBe(false)
    if (!dirtyRes.ok) expect(dirtyRes.code).toBe("dirty_checkout")

    const unverifiedRes = await resolveCliExecutionTrust({
      checkout: {
        repository: "local/tmp",
        repositorySource: "local-directory",
        commitSha: "uncommitted-workspace",
        commitSource: "uncommitted",
        commitVerified: false,
        dirty: null,
        ref: null,
        envCommitMismatch: null
      },
      requestedTier: "trusted:sandbox",
      receiptPath: "/tmp/receipt.json",
      adapter: dummyAdapter
    })
    expect(unverifiedRes.ok).toBe(false)
    if (!unverifiedRes.ok) expect(unverifiedRes.code).toBe("unverified_checkout_commit")

    const mismatchRes = await resolveCliExecutionTrust({
      checkout: {
        repository: "smithersai/smithers-ci",
        repositorySource: "git-config",
        commitSha: SOURCE_COMMIT,
        commitSource: "git",
        commitVerified: true,
        dirty: false,
        ref: "refs/heads/main",
        envCommitMismatch: PACKED_COMMIT
      },
      requestedTier: "trusted:sandbox",
      receiptPath: "/tmp/receipt.json",
      adapter: dummyAdapter
    })
    expect(mismatchRes.ok).toBe(false)
    if (!mismatchRes.ok) expect(mismatchRes.code).toBe("identity_mismatch")
  })

})
