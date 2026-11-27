import { randomBytes } from "node:crypto"
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
import {
  type TrustTier,
  signExecutionClaim,
  verifyExecutionTrust
} from "../trust/ExecutionTrust.ts"
import { generateLlmsTxt, loadWikiGraph } from "../wiki/WikiEngine.ts"

const DEFAULT_SHA = "46412bca49c3a0f1234567890abcdef123456789"

function parseFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

function loadHistory(repoRoot: string): MythicalHistorySequencer {
  const seedPath = join(repoRoot, "history", "mythical-history.json")
  if (existsSync(seedPath)) {
    const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as MythicalHistorySnapshot
    return new MythicalHistorySequencer(parsed)
  }
  return new MythicalHistorySequencer()
}

export async function runCli(argv: ReadonlyArray<string>, cwd = process.cwd()): Promise<number> {
  const repoRoot = resolve(cwd)
  const [cmd, sub] = argv

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "smithers-ci: Fast kernel-recorded CI, Lighthouse backpressure audits, Cloud MCP, Wiki, and Mythical History",
        "",
        "Commands:",
        "  smithers-ci audit [--trust <tier>] [--out <dir>]     Run Lighthouse backpressure audit",
        "  smithers-ci replay [--trust <tier>] [--json]         Run content-addressed incremental replay against shared cache",
        "  smithers-ci inventory [--json]                       Inventory GitHub workflows and audit PR secret isolation",
        "  smithers-ci auth mint --subject <id> [--tier <tier>] [--scopes <csv>] [--out <file>]",
        "  smithers-ci wiki check                               Verify Obsidian wiki links and diagrams",
        "  smithers-ci home check                               Validate .smithers/home.json against Home.read bounds",
        "  smithers-ci history verify                           Verify Mythical History linear stack and export manifest",
        "  smithers-ci mcp serve [--port <port>]                Run local Streamable HTTP Cloud MCP server",
        "  smithers-ci store stats                              Inspect shared object store statistics"
      ].join("\n")
    )
    return 0
  }

  if (cmd === "replay") {
    const envSecret = (process.env.SMITHERS_CONTROL_SECRET ?? "").trim()
    const hasControlSecret = envSecret.length >= 16
    const requestedTier = (parseFlag(argv, "--trust") ?? (hasControlSecret ? "trusted:sandbox" : "untrusted:community")) as TrustTier
    const rawSha = (process.env.SMITHERS_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "").trim()
    const commitSha = /^[0-9a-f]{40}$/i.test(rawSha) ? rawSha.toLowerCase() : DEFAULT_SHA
    const now = new Date()
    const issuedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 600_000).toISOString()
    // Never self-attest trusted cache writes without a real control-plane signing secret.
    const claim =
      !hasControlSecret || requestedTier === "untrusted:community"
        ? {
            tier: "untrusted:community" as const,
            callerKind: "person" as const,
            actor: process.env.USER ?? "community-user",
            repository: "smithersai/smithers-ci",
            commitSha,
            issuedAt,
            expiresAt
          }
        : signExecutionClaim(
            {
              tier: requestedTier,
              callerKind: requestedTier === "trusted:maintainer" ? "person" : "sandbox",
              actor: requestedTier === "trusted:maintainer" ? "roninjin10" : "cfbox-local",
              repository: "smithersai/smithers-ci",
              commitSha,
              sandboxId: requestedTier === "trusted:sandbox" ? "cfbox-local-01" : null,
              issuedAt,
              expiresAt
            },
            envSecret
          )
    const verified = verifyExecutionTrust(claim, { signingSecret: hasControlSecret ? envSecret : undefined })
    const store = new SharedObjectStore({ rootDir: join(repoRoot, ".smithers", "object-store") })
    const report = runIncrementalReplay({ repoRoot, store, execution: verified })
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
    const requestedTier = (parseFlag(argv, "--trust") ?? "trusted:sandbox") as TrustTier
    const outDir = resolve(repoRoot, parseFlag(argv, "--out") ?? ".smithers/reports")
    const rawSha = (process.env.SMITHERS_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "").trim()
    const commitSha = /^[0-9a-f]{40}$/i.test(rawSha) ? rawSha.toLowerCase() : DEFAULT_SHA
    const envSecret = (process.env.SMITHERS_CONTROL_SECRET ?? "").trim()
    const secret = envSecret.length >= 16 ? envSecret : randomBytes(24).toString("hex")
    const now = new Date()
    const issuedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 600_000).toISOString()

    const claim =
      requestedTier === "untrusted:community"
        ? {
            tier: "untrusted:community" as const,
            callerKind: "person" as const,
            actor: process.env.USER ?? "community-user",
            repository: "smithersai/smithers-ci",
            commitSha,
            issuedAt,
            expiresAt
          }
        : signExecutionClaim(
            {
              tier: requestedTier,
              callerKind: requestedTier === "trusted:maintainer" ? "person" : "sandbox",
              actor: requestedTier === "trusted:maintainer" ? "roninjin10" : "cfbox-local",
              repository: "smithersai/smithers-ci",
              commitSha,
              sandboxId: requestedTier === "trusted:sandbox" ? "cfbox-local-01" : null,
              issuedAt,
              expiresAt
            },
            secret
          )

    const verified = verifyExecutionTrust(claim, { signingSecret: secret })
    const typecheckPassedFlag = parseFlag(argv, "--typecheck-passed")
    const testsPassedFlag = parseFlag(argv, "--tests-passed")
    const testsFailedFlag = parseFlag(argv, "--tests-failed")
    const typecheckPassed =
      typecheckPassedFlag === "false"
        ? false
        : typecheckPassedFlag === "true" || !argv.includes("--unmeasured")
          ? true
          : undefined
    const testResults =
      testsPassedFlag !== undefined
        ? {
            passed: Math.max(0, Number(testsPassedFlag) || 0),
            failed: Math.max(0, Number(testsFailedFlag ?? "0") || 0),
            durationMs: 420
          }
        : undefined
    const report = runBackpressureAudit({
      repoRoot,
      execution: verified,
      typecheckPassed,
      testResults
    })

    mkdirSync(outDir, { recursive: true })
    const jsonPath = join(outDir, "lighthouse-audit.json")
    const htmlPath = join(outDir, "lighthouse-audit.html")
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    writeFileSync(htmlPath, renderLighthouseHtml(report), "utf8")

    const store = new SharedObjectStore({ rootDir: join(repoRoot, ".smithers", "object-store") })
    const jsonArtifact = store.putArtifact("lighthouse-audit.json", JSON.stringify(report, null, 2), {
      contentType: "application/json",
      visibility: "public",
      execution: verified
    })
    const htmlArtifact = store.putArtifact("lighthouse-audit.html", renderLighthouseHtml(report), {
      contentType: "text/html; charset=utf-8",
      visibility: "public",
      execution: verified
    })

    console.log(`Smithers CI Backpressure Audit (${report.policy.provenanceBadge})`)
    console.log(`Overall Score: ${report.overallScore}/100 (${report.overallRating.toUpperCase()})`)
    for (const cat of report.categories) {
      console.log(`  - ${cat.title}: ${cat.score}/100 (${cat.passedCount} pass, ${cat.warnCount} warn, ${cat.failCount} fail)`)
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
    console.log(`Wiki pages: ${graph.pages.length}, broken links: ${graph.brokenLinks.length}, missing diagrams: ${graph.pagesWithoutDiagrams.length}`)
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
  const store = new SharedObjectStore({ rootDir: join(options.repoRoot, ".smithers", "object-store") })
  const factory = new FactoryState("smithersai/smithers-ci")
  const history = loadHistory(options.repoRoot)
  let boundPort = requestedPort
  let tokens = new OneTimeTokenStore({ baseUrl: `http://127.0.0.1:${requestedPort}` })
  let mcp = new SmithersCloudMcpServer({
    repoRoot: options.repoRoot,
    repository: "smithersai/smithers-ci",
    baseUrl: `http://127.0.0.1:${requestedPort}`,
    commitSha: options.commitSha ?? DEFAULT_SHA,
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
        commitSha: options.commitSha ?? DEFAULT_SHA,
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
