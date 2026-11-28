import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { runBackpressureAudit } from "../audit/AuditEngine.ts"
import { renderLighthouseHtml } from "../audit/LighthouseHtml.ts"
import {
  OneTimeTokenStore,
  formatBootstrapEnvelope,
  writeTokenFile
} from "../auth/OneTimeToken.ts"
import { formatReplayReport, runIncrementalReplay } from "../ci/ReplayEngine.ts"
import { inventoryGithubWorkflows } from "../ci/WorkflowInventory.ts"
import { validateHomeJson } from "../factory/Audience.ts"
import { FactoryState } from "../factory/FactoryState.ts"
import {
  MythicalHistorySequencer,
  type MythicalHistorySnapshot,
  verifyMythicalHistory
} from "../history/MythicalHistory.ts"
import { SmithersCloudMcpServer, type JsonRpcRequest } from "../mcp/McpServer.ts"
import { SharedObjectStore } from "../store/ObjectStore.ts"
import type { TrustTier } from "../trust/ExecutionTrust.ts"
import {
  type ExternalTrustReceiptAdapter,
  resolveCliExecutionTrust
} from "../trust/TrustReceipt.ts"
import { generateLlmsTxt, loadWikiGraph } from "../wiki/WikiEngine.ts"
import { resolveCheckoutIdentity } from "./CheckoutIdentity.ts"

export interface CliRunOptions {
  readonly trustReceiptAdapter?: ExternalTrustReceiptAdapter | null
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
}

type FlagParseResult =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly value: string }
  | { readonly state: "missing_value" }

function readFlag(argv: ReadonlyArray<string>, name: string): FlagParseResult {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        return { state: "missing_value" }
      }
      return { state: "present", value: next }
    }
    if (arg.startsWith(`${name}=`)) {
      const val = arg.slice(name.length + 1)
      if (val.length === 0) return { state: "missing_value" }
      return { state: "present", value: val }
    }
  }
  return { state: "absent" }
}

function parseFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const parsed = readFlag(argv, name)
  return parsed.state === "present" ? parsed.value : undefined
}

function parseNonNegativeInt(raw: string, flagName: string): number | null {
  if (!/^\d+$/.test(raw.trim())) {
    console.error(`Invalid value for ${flagName}: expected a non-negative integer, received "${raw}"`)
    return null
  }
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(`Invalid value for ${flagName}: out of range "${raw}"`)
    return null
  }
  return value
}

function loadHistory(repoRoot: string): MythicalHistorySequencer {
  const seedPath = join(repoRoot, "history", "mythical-history.json")
  if (existsSync(seedPath)) {
    const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as MythicalHistorySnapshot
    return new MythicalHistorySequencer(parsed)
  }
  return new MythicalHistorySequencer()
}

export async function runCli(
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  options: CliRunOptions = {}
): Promise<number> {
  const repoRoot = resolve(cwd)
  const env = options.env ?? process.env
  const [cmd, sub] = argv

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "smithers-ci: Fast kernel-recorded CI, Lighthouse backpressure audits, Cloud MCP, Wiki, and Mythical History",
        "",
        "Commands:",
        "  smithers-ci audit [--trust untrusted:community] [--trust-receipt <file>] [--out <dir>]",
        "                    [--typecheck-passed true|false] [--tests-passed <n>] [--tests-failed <n>]",
        "                                                     Run Lighthouse backpressure audit (defaults to untrusted:community)",
        "  smithers-ci replay [--trust untrusted:community] [--trust-receipt <file>] [--json]",
        "                                                     Run content-addressed incremental replay against shared cache",
        "  smithers-ci inventory [--json]                     Inventory GitHub workflows and audit PR secret isolation",
        "  smithers-ci auth mint --subject <id> [--tier <tier>] [--scopes <csv>] [--out <file>]",
        "  smithers-ci wiki check                             Verify Obsidian wiki links and diagrams",
        "  smithers-ci home check                             Validate .smithers/home.json against Home.read bounds",
        "  smithers-ci history verify                         Verify Mythical History linear stack and export manifest",
        "  smithers-ci mcp serve [--port <port>]              Run local Streamable HTTP Cloud MCP server",
        "  smithers-ci store stats                            Inspect shared object store statistics"
      ].join("\n")
    )
    return 0
  }

  if (cmd === "replay") {
    const trustFlag = readFlag(argv, "--trust")
    if (trustFlag.state === "missing_value") {
      console.error("Missing value for --trust")
      return 2
    }
    const receiptFlag = readFlag(argv, "--trust-receipt")
    if (receiptFlag.state === "missing_value") {
      console.error("Missing value for --trust-receipt")
      return 2
    }

    const checkout = resolveCheckoutIdentity(repoRoot, env)
    const receiptPath =
      receiptFlag.state === "present"
        ? receiptFlag.value
        : (env.SMITHERS_TRUST_RECEIPT?.trim() || null)

    const trust = await resolveCliExecutionTrust({
      checkout,
      requestedTier: trustFlag.state === "present" ? trustFlag.value : null,
      receiptPath,
      adapter: options.trustReceiptAdapter ?? null,
      env,
      now: options.now
    })
    if (!trust.ok) {
      console.error(trust.message)
      return 1
    }

    const store = new SharedObjectStore({ rootDir: join(repoRoot, ".smithers", "object-store") })
    const report = runIncrementalReplay({ repoRoot, store, execution: trust.execution })
    if (argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(formatReplayReport(report))
    }
    return report.mismatches === 0 ? 0 : 1
  }

  if (cmd === "inventory") {
    const inv = inventoryGithubWorkflows(repoRoot)
    if (argv.includes("--json")) {
      console.log(JSON.stringify(inv, null, 2))
    } else {
      console.log(
        `Smithers CI Workflow Inventory: ${inv.workflows.length} workflows, ${inv.totalJobs} jobs, ${inv.totalSteps} steps, ${inv.totalSecurityFindings} security findings`
      )
      for (const wf of inv.workflows) {
        console.log(`  - ${wf.file} (${wf.triggers.join(", ")}): ${wf.jobs.length} jobs`)
        for (const f of wf.securityFindings) console.error(`    SECURITY: ${f}`)
      }
    }
    return inv.untrustedSafe ? 0 : 1
  }

  if (cmd === "audit") {
    const trustFlag = readFlag(argv, "--trust")
    if (trustFlag.state === "missing_value") {
      console.error("Missing value for --trust")
      return 2
    }
    const receiptFlag = readFlag(argv, "--trust-receipt")
    if (receiptFlag.state === "missing_value") {
      console.error("Missing value for --trust-receipt")
      return 2
    }
    const outFlag = readFlag(argv, "--out")
    if (outFlag.state === "missing_value") {
      console.error("Missing value for --out")
      return 2
    }
    const typecheckPassedFlag = readFlag(argv, "--typecheck-passed")
    if (typecheckPassedFlag.state === "missing_value") {
      console.error("Missing value for --typecheck-passed")
      return 2
    }
    const typecheckDurationFlag = readFlag(argv, "--typecheck-duration-ms")
    if (typecheckDurationFlag.state === "missing_value") {
      console.error("Missing value for --typecheck-duration-ms")
      return 2
    }
    const testsPassedFlag = readFlag(argv, "--tests-passed")
    if (testsPassedFlag.state === "missing_value") {
      console.error("Missing value for --tests-passed")
      return 2
    }
    const testsFailedFlag = readFlag(argv, "--tests-failed")
    if (testsFailedFlag.state === "missing_value") {
      console.error("Missing value for --tests-failed")
      return 2
    }
    const testsDurationFlag = readFlag(argv, "--tests-duration-ms")
    if (testsDurationFlag.state === "missing_value") {
      console.error("Missing value for --tests-duration-ms")
      return 2
    }

    const forceUnmeasured = argv.includes("--unmeasured")
    let typecheckPassed: boolean | undefined
    if (!forceUnmeasured && typecheckPassedFlag.state === "present") {
      if (typecheckPassedFlag.value === "true") {
        typecheckPassed = true
      } else if (typecheckPassedFlag.value === "false") {
        typecheckPassed = false
      } else {
        console.error(
          `Invalid value for --typecheck-passed: expected "true" or "false", received "${typecheckPassedFlag.value}"`
        )
        return 2
      }
    }

    let typecheckDurationMs: number | undefined
    if (!forceUnmeasured && typecheckDurationFlag.state === "present") {
      const parsed = parseNonNegativeInt(typecheckDurationFlag.value, "--typecheck-duration-ms")
      if (parsed === null) return 2
      typecheckDurationMs = parsed
    }

    let testResults: { readonly passed: number; readonly failed: number; readonly durationMs: number } | undefined
    if (!forceUnmeasured && (testsPassedFlag.state === "present" || testsFailedFlag.state === "present")) {
      const passed =
        testsPassedFlag.state === "present"
          ? parseNonNegativeInt(testsPassedFlag.value, "--tests-passed")
          : 0
      if (passed === null) return 2
      const failed =
        testsFailedFlag.state === "present"
          ? parseNonNegativeInt(testsFailedFlag.value, "--tests-failed")
          : 0
      if (failed === null) return 2
      const durationMs =
        testsDurationFlag.state === "present"
          ? parseNonNegativeInt(testsDurationFlag.value, "--tests-duration-ms")
          : 0
      if (durationMs === null) return 2
      testResults = { passed, failed, durationMs }
    }

    const checkout = resolveCheckoutIdentity(repoRoot, env)
    const receiptPath =
      receiptFlag.state === "present"
        ? receiptFlag.value
        : (env.SMITHERS_TRUST_RECEIPT?.trim() || null)

    const trust = await resolveCliExecutionTrust({
      checkout,
      requestedTier: trustFlag.state === "present" ? trustFlag.value : null,
      receiptPath,
      adapter: options.trustReceiptAdapter ?? null,
      env,
      now: options.now
    })
    if (!trust.ok) {
      console.error(trust.message)
      return 1
    }

    if (checkout.envCommitMismatch) {
      console.error(
        `Warning: environment commit SHA (${checkout.envCommitMismatch}) disagrees with checkout commit (${checkout.commitSha}); using actual checkout identity.`
      )
    }

    const outDir = resolve(repoRoot, outFlag.state === "present" ? outFlag.value : ".smithers/reports")
    const report = runBackpressureAudit({
      repoRoot,
      execution: trust.execution,
      typecheckPassed,
      typecheckDurationMs,
      testResults
    })

    const jsonBody = `${JSON.stringify(report, null, 2)}\n`
    const htmlBody = renderLighthouseHtml(report)

    mkdirSync(outDir, { recursive: true })
    const jsonPath = join(outDir, "lighthouse-audit.json")
    const htmlPath = join(outDir, "lighthouse-audit.html")
    writeFileSync(jsonPath, jsonBody, "utf8")
    writeFileSync(htmlPath, htmlBody, "utf8")

    const store = new SharedObjectStore({ rootDir: join(repoRoot, ".smithers", "object-store") })
    const jsonArtifact = store.putArtifact("lighthouse-audit.json", jsonBody, {
      contentType: "application/json",
      visibility: "public",
      execution: trust.execution
    })
    const htmlArtifact = store.putArtifact("lighthouse-audit.html", htmlBody, {
      contentType: "text/html; charset=utf-8",
      visibility: "public",
      execution: trust.execution
    })

    console.log(`Smithers CI Backpressure Audit (${report.policy.provenanceBadge})`)
    console.log(`Checkout: ${report.repository} @ ${report.commitSha} (${checkout.commitSource})`)
    console.log(
      `Provenance: ${report.execution.effectiveTier} (${
        trust.elevated
          ? `verified via ${trust.adapterId}`
          : "local/untrusted; no external trust receipt verified"
      })`
    )
    console.log(`Overall Score: ${report.overallScore}/100 (${report.overallRating.toUpperCase()})`)
    for (const cat of report.categories) {
      console.log(
        `  - ${cat.title}: ${cat.score}/100 (${cat.passedCount} pass, ${cat.warnCount} warn, ${cat.failCount} fail)`
      )
    }
    console.log(`Gate: ${report.gate.status} (${report.gate.satisfied ? "SATISFIED" : "NOT SATISFIED"})`)
    console.log(`Artifacts stored: ${jsonArtifact.key}, ${htmlArtifact.key}`)
    console.log(`HTML report: ${htmlPath}`)

    return report.summary.failed === 0 ? 0 : 1
  }

  if (cmd === "auth" && sub === "mint") {
    const subject = parseFlag(argv, "--subject") ?? "sandbox:cfbox-ephemeral"
    const tier = (parseFlag(argv, "--tier") ?? "trusted:sandbox") as TrustTier
    const scopesCsv =
      parseFlag(argv, "--scopes") ??
      "mcp:read,mcp:write,cache:read,cache:write,artifact:write:trusted,todo:draft,issue:create,changeset:propose,audit:run"
    const outFile = parseFlag(argv, "--out")
    const ttlSeconds = Number(parseFlag(argv, "--ttl") ?? "300")
    const store = new OneTimeTokenStore()
    const minted = store.mint({
      repository: "smithersai/smithers-ci",
      subject,
      mintedBy: "roninjin10",
      trustTier: tier,
      scopes: scopesCsv.split(","),
      sandboxId: tier === "trusted:sandbox" ? subject.replace(/^sandbox:/, "") : null,
      ttlSeconds
    })

    if (outFile) {
      const files = writeTokenFile(resolve(repoRoot, outFile), minted)
      console.log(`Wrote mode-600 one-time token: ${files.tokenPath}`)
      console.log(`Wrote scope receipt:           ${files.receiptPath}`)
      return 0
    }

    console.log(formatBootstrapEnvelope(minted))
    return 0
  }

  if (cmd === "wiki" && sub === "check") {
    const graph = loadWikiGraph(join(repoRoot, "wiki"))
    console.log(
      `Wiki pages: ${graph.pages.length}, broken links: ${graph.brokenLinks.length}, missing diagrams: ${graph.pagesWithoutDiagrams.length}`
    )
    if (graph.brokenLinks.length > 0) {
      for (const b of graph.brokenLinks) {
        console.error(`  BROKEN: ${b.from} -> [[${b.target}]]`)
      }
      return 1
    }
    if (graph.pagesWithoutDiagrams.length > 0) {
      console.error(`  MISSING DIAGRAMS: ${graph.pagesWithoutDiagrams.join(", ")}`)
      return 1
    }
    const llms = generateLlmsTxt(graph)
    writeFileSync(join(repoRoot, "wiki", "llms.txt"), llms, "utf8")
    console.log(`Wiki digest: ${graph.digest.slice(0, 16)} (llms.txt updated)`)
    return 0
  }

  if (cmd === "home" && sub === "check") {
    const homePath = join(repoRoot, ".smithers", "home.json")
    if (!existsSync(homePath)) {
      console.error("Missing .smithers/home.json")
      return 1
    }
    const res = validateHomeJson(readFileSync(homePath, "utf8"))
    if (!res.valid) {
      console.error(`Home invalid: ${res.reason}`)
      return 1
    }
    console.log(
      `Home valid: ${res.sectionsCount} sections, ${res.blocksCount} blocks, audiences: ${res.audiences.join(", ")}`
    )
    return 0
  }

  if (cmd === "history" && sub === "verify") {
    const seq = loadHistory(repoRoot)
    const snap = seq.snapshot()
    const check = verifyMythicalHistory(snap)
    if (!check.valid) {
      for (const issue of check.issues) console.error(`  HISTORY ERROR: ${issue}`)
      return 1
    }
    const manifest = seq.exportManifest()
    writeFileSync(
      join(repoRoot, "history", "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    )
    console.log(
      `Mythical History verified: ${snap.epics.length} epics, ${snap.commits.length} commits, manifest ${manifest.manifestDigest.slice(0, 16)}`
    )
    return 0
  }

  if (cmd === "store" && sub === "stats") {
    const store = new SharedObjectStore({ rootDir: join(repoRoot, ".smithers", "object-store") })
    console.log(JSON.stringify(store.stats(), null, 2))
    return 0
  }

  if (cmd === "mcp" && sub === "serve") {
    const port = Number(parseFlag(argv, "--port") ?? "7440")
    const started = await startLocalMcpHttpServer({ repoRoot, port })
    console.log(`Smithers CI Cloud MCP listening on ${started.baseUrl}/smithersai/smithers-ci/mcp`)
    if (argv.includes("--mint-bootstrap")) {
      const minted = started.tokens.mint({
        repository: "smithersai/smithers-ci",
        subject: parseFlag(argv, "--subject") ?? "sandbox:cfbox-local-01",
        mintedBy: "roninjin10",
        trustTier: "trusted:sandbox",
        scopes: [
          "mcp:read",
          "mcp:write",
          "cache:read",
          "cache:write",
          "artifact:read",
          "artifact:write:trusted",
          "todo:draft",
          "issue:create",
          "issue:comment",
          "pr:draft",
          "changeset:propose",
          "audit:run"
        ],
        sandboxId: "cfbox-local-01"
      })
      console.log(formatBootstrapEnvelope(minted))
    }
    return 0
  }

  console.error(`Unknown command: ${argv.join(" ")}`)
  return 2
}

const MAX_LOCAL_HTTP_BODY = 256 * 1024

export async function startLocalMcpHttpServer(options: {
  readonly repoRoot: string
  readonly port?: number
  readonly commitSha?: string
}): Promise<{
  readonly server: Server
  readonly port: number
  readonly baseUrl: string
  readonly tokens: OneTimeTokenStore
  readonly store: SharedObjectStore
  readonly factory: FactoryState
  readonly close: () => Promise<void>
}> {
  const requestedPort = options.port ?? 0
  const checkout = resolveCheckoutIdentity(options.repoRoot)
  const commitSha = options.commitSha ?? checkout.commitSha
  const store = new SharedObjectStore({ rootDir: join(options.repoRoot, ".smithers", "object-store") })
  const factory = new FactoryState("smithersai/smithers-ci")
  const history = loadHistory(options.repoRoot)
  let boundPort = requestedPort
  let tokens = new OneTimeTokenStore({ baseUrl: `http://127.0.0.1:${requestedPort}` })
  let mcp = new SmithersCloudMcpServer({
    repoRoot: options.repoRoot,
    repository: "smithersai/smithers-ci",
    baseUrl: `http://127.0.0.1:${requestedPort}`,
    commitSha,
    store,
    tokens,
    factory,
    history
  })

  const readJsonBody = (
    req: import("node:http").IncomingMessage,
    onDone: (err: { status: number; body: Record<string, unknown> } | null, parsed?: Record<string, unknown>) => void
  ): void => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on("data", (c: Buffer) => {
      if (aborted) return
      total += c.byteLength
      if (total > MAX_LOCAL_HTTP_BODY) {
        aborted = true
        onDone({ status: 413, body: { error: "payload_too_large" } })
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (aborted) return
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          onDone({ status: 400, body: { error: "invalid_json" } })
          return
        }
        onDone(null, parsed as Record<string, unknown>)
      } catch {
        onDone({ status: 400, body: { error: "invalid_json" } })
      }
    })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`)
    res.setHeader("content-type", "application/json; charset=utf-8")
    res.setHeader("cache-control", "no-store")
    res.setHeader("x-content-type-options", "nosniff")

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      res.end(JSON.stringify(mcp.oauthProtectedResourceMetadata()))
      return
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      res.end(JSON.stringify(mcp.oauthAuthorizationServerMetadata()))
      return
    }
    if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/smithersai/smithers-ci/mcp")) {
      readJsonBody(req, (err, payload) => {
        if (err || !payload) {
          res.statusCode = err?.status ?? 400
          res.end(JSON.stringify(err?.body ?? { error: "invalid_json" }))
          return
        }
        const answer = mcp.handleRpc(payload as unknown as JsonRpcRequest, req.headers.authorization)
        if (answer.error?.code === -32001) {
          res.statusCode = 401
        }
        res.end(JSON.stringify(answer))
      })
      return
    }
    if (req.method === "POST" && url.pathname === "/smithersai/smithers-ci/mcp/exchange") {
      readJsonBody(req, (err, body) => {
        if (err || !body) {
          res.statusCode = err?.status ?? 400
          res.end(JSON.stringify(err?.body ?? { error: "invalid_json" }))
          return
        }
        const redeemed = tokens.redeem({
          rawToken: typeof body.token === "string" ? body.token : "",
          repository: "smithersai/smithers-ci",
          pkceVerifier: typeof body.pkceVerifier === "string" ? body.pkceVerifier : null
        })
        if (!redeemed.ok) {
          res.statusCode = 401
          res.end(JSON.stringify(redeemed))
          return
        }
        res.end(
          JSON.stringify({
            ok: true,
            leaseToken: redeemed.lease.rawLeaseToken,
            leaseId: redeemed.lease.leaseId,
            trustTier: redeemed.lease.trustTier,
            scopes: redeemed.lease.scopes,
            expiresAt: redeemed.lease.expiresAt
          })
        )
      })
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: "not_found" }))
  })

  await new Promise<void>((resolveListen) => {
    server.listen(requestedPort, "127.0.0.1", () => {
      const addr = server.address()
      boundPort = typeof addr === "object" && addr ? addr.port : requestedPort
      const baseUrl = `http://127.0.0.1:${boundPort}`
      tokens = new OneTimeTokenStore({ baseUrl })
      mcp = new SmithersCloudMcpServer({
        repoRoot: options.repoRoot,
        repository: "smithersai/smithers-ci",
        baseUrl,
        commitSha,
        store,
        tokens,
        factory,
        history
      })
      resolveListen()
    })
  })

  const baseUrl = `http://127.0.0.1:${boundPort}`
  return {
    server,
    port: boundPort,
    baseUrl,
    tokens,
    store,
    factory,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}
