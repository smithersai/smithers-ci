import {
  type TrustTier,
  type VerifiedExecution,
  authorizeAction
} from "../trust/ExecutionTrust.ts"

export interface TodoItem {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly status: "draft" | "committed" | "in_progress" | "done" | "dropped"
  readonly priority: "P0" | "P1" | "P2"
  readonly author: string
  readonly visibility: "public" | "private"
  readonly linkedIssue: number | null
  readonly createdAt: string
}

export interface IssueRecord {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: "open" | "closed"
  readonly triage: "untriaged" | "accepted" | "needs-repro" | "committed"
  readonly author: string
  readonly labels: ReadonlyArray<string>
  readonly comments: Array<{ readonly author: string; readonly body: string; readonly at: string }>
  readonly createdAt: string
}

export interface ChangesetRecord {
  readonly id: string
  readonly stackPosition: number
  readonly parentId: string | null
  readonly branch: string
  readonly title: string
  readonly commitSha: string
  readonly author: string
  readonly trustTier: TrustTier
  readonly auditScore: number
  readonly gateSatisfied: boolean
  readonly state: "draft" | "review" | "ready" | "merged"
  readonly diffSummary: string
  readonly updatedAt: string
}

export interface PullRequestRecord {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly branch: string
  readonly baseBranch: string
  readonly author: string
  readonly authorContributions: number
  readonly state: "open" | "merged" | "closed"
  readonly changesetIds: ReadonlyArray<string>
  readonly trustTier: TrustTier
  readonly auditScore: number
  readonly gateSatisfied: boolean
  readonly mirrorSyncedToGithub: boolean
  readonly createdAt: string
}

export interface FactoryRunRecord {
  readonly id: string
  readonly flow: string
  readonly commitSha: string
  readonly actor: string
  readonly trustTier: TrustTier
  readonly status: "running" | "passed" | "failed" | "untrusted_preview"
  readonly auditScore: number
  readonly durationMs: number
  readonly cacheHitRate: number
  readonly startedAt: string
}

export class FactoryActionError extends Error {
  readonly code: "person_only" | "maintainer_required" | "not_found" | "gate_not_satisfied" | "invalid"
  readonly httpStatus: number

  constructor(code: FactoryActionError["code"], message: string, httpStatus = 403) {
    super(message)
    this.name = "FactoryActionError"
    this.code = code
    this.httpStatus = httpStatus
  }
}

function formatAttribution(execution: VerifiedExecution): string {
  return execution.callerKind === "person" ? execution.actor : `${execution.actor} (${execution.callerKind})`
}

/**
 * Unified local-first Factory core shared across all 4 Smithers clients:
 * 1. Cloud MCP Server
 * 2. CLI / Agent Skill
 * 3. TypeScript SDK
 * 4. Thin React Web UI
 */
export class FactoryState {
  readonly repository: string
  private readonly todos: TodoItem[]
  private readonly issues: IssueRecord[]
  private readonly changesets: ChangesetRecord[]
  private readonly pulls: PullRequestRecord[]
  private readonly runs: FactoryRunRecord[]
  private nextIssueNumber: number
  private nextPrNumber: number

  constructor(repository = "smithersai/smithers-ci") {
    this.repository = repository
    this.todos = [
      {
        id: "todo-1",
        title: "Publish smithers-ci 1.0.0-rc.20 with native smthrs-observe binaries",
        body: "Automated mirror merge from smithers.sh to GitHub triggers trusted Lighthouse audit, npm provenance publish, and docs deploy.",
        status: "committed",
        priority: "P0",
        author: "roninjin10",
        visibility: "public",
        linkedIssue: 1,
        createdAt: "2026-11-26T18:46:00.000Z"
      },
      {
        id: "todo-2",
        title: "Verify zero-stale-pass replay across Tevm and Smithers universes",
        body: "Run isolated replay benchmarks across zevm, voltaire, vibelang, claude-p, and zmux using the shared build.smithers.sh object store.",
        status: "in_progress",
        priority: "P0",
        author: "roninjin10 (agent)",
        visibility: "public",
        linkedIssue: 2,
        createdAt: "2026-11-26T20:15:00.000Z"
      },
      {
        id: "todo-3",
        title: "Expose one-time sandbox auth minter over Cloud MCP for external runners",
        body: "Mint single-use smo_ tokens with PKCE S256 and strict trust-tier scope intersection.",
        status: "done",
        priority: "P1",
        author: "roninjin10 (agent)",
        visibility: "public",
        linkedIssue: 3,
        createdAt: "2026-11-26T23:30:00.000Z"
      },
      {
        id: "todo-4",
        title: "Expand Zig closure discovery for cross-compiled static archives",
        body: "Community contributors can test locally with untrusted preview runs before maintainer sandbox verification.",
        status: "draft",
        priority: "P2",
        author: "alice-dev (agent)",
        visibility: "public",
        linkedIssue: 4,
        createdAt: "2026-11-26T23:45:00.000Z"
      }
    ]

    this.issues = [
      {
        number: 1,
        title: "Switch smithers-ci permanently onto public Smithers Cloud factory",
        body: "Host public TODOs, Lighthouse backpressure audits, Cloud MCP, Wiki, Mythical History, and GitHub mirror release automation at smithers.sh/smithersai/smithers-ci.",
        state: "open",
        triage: "committed",
        author: "roninjin10",
        labels: ["epic", "smithers-cloud", "release"],
        comments: [
          {
            author: "roninjin10 (agent)",
            body: "Shared object store, ExecutionTrust boundary, OneTimeToken minter, Lighthouse audit report, and Cloud MCP server wired and tested.",
            at: "2026-11-26T23:42:00.000Z"
          }
        ],
        createdAt: "2026-11-26T18:00:00.000Z"
      },
      {
        number: 2,
        title: "Dogfood Smithers CI on zevm, voltaire, and vibelang",
        body: "Track zero-mismatch replay speedups and shared build.smithers.sh cache hit rates across every first-party repository.",
        state: "open",
        triage: "accepted",
        author: "roninjin10",
        labels: ["dogfood", "benchmarks"],
        comments: [],
        createdAt: "2026-11-26T19:30:00.000Z"
      },
      {
        number: 3,
        title: "Allow untrusted community replay runs without risking cache poisoning",
        body: "Contributors and viewers should run replays freely with warm read-only cache hits while write credentials and release gates remain strictly confined to controlled sandboxes and maintainers.",
        state: "closed",
        triage: "committed",
        author: "alice-dev",
        labels: ["security", "trust-boundary"],
        comments: [
          {
            author: "roninjin10",
            body: "Shipped with ExecutionTrust constant-time HMAC verification and isolated untrusted/<actor>/<sha> artifact namespaces.",
            at: "2026-11-26T23:38:00.000Z"
          }
        ],
        createdAt: "2026-11-25T16:10:00.000Z"
      },
      {
        number: 4,
        title: "Add Swift and Rust C-ABI target splitting hints",
        body: "Detect workspace crates and SwiftPM targets automatically when decomposing multi-language CI workflows.",
        state: "open",
        triage: "untriaged",
        author: "bob-oss",
        labels: ["enhancement", "community"],
        comments: [],
        createdAt: "2026-11-26T22:15:00.000Z"
      }
    ]

    this.changesets = [
      {
        id: "cs-01",
        stackPosition: 1,
        parentId: null,
        branch: "stack/01-trust-and-object-store",
        title: "feat(trust): ExecutionTrust 3-tier boundary and SharedObjectStore CAS isolation",
        commitSha: "46412bca49c3a0f1234567890abcdef123456789",
        author: "roninjin10",
        trustTier: "trusted:sandbox",
        auditScore: 100,
        gateSatisfied: true,
        state: "merged",
        diffSummary: "+420 -0 across src/trust/ExecutionTrust.ts, src/store/ObjectStore.ts",
        updatedAt: "2026-11-26T23:38:00.000Z"
      },
      {
        id: "cs-02",
        stackPosition: 2,
        parentId: "cs-01",
        branch: "stack/02-lighthouse-backpressure",
        title: "feat(audit): Lighthouse-style 6-category backpressure audit engine and HTML report",
        commitSha: "9e0efd0d871f1234567890abcdef1234567890ab",
        author: "roninjin10 (agent)",
        trustTier: "trusted:sandbox",
        auditScore: 99,
        gateSatisfied: true,
        state: "ready",
        diffSummary: "+610 -0 across src/audit/AuditEngine.ts, src/audit/LighthouseHtml.ts",
        updatedAt: "2026-11-26T23:41:00.000Z"
      },
      {
        id: "cs-03",
        stackPosition: 3,
        parentId: "cs-02",
        branch: "stack/03-cloud-mcp-and-ott",
        title: "feat(mcp): Authenticated Cloud MCP server with one-time sandbox auth minter",
        commitSha: "1ac184541b6d1234567890abcdef1234567890cd",
        author: "roninjin10 (agent)",
        trustTier: "trusted:sandbox",
        auditScore: 98,
        gateSatisfied: true,
        state: "review",
        diffSummary: "+540 -0 across src/auth/OneTimeToken.ts, src/mcp/McpServer.ts",
        updatedAt: "2026-11-26T23:44:00.000Z"
      },
      {
        id: "cs-04",
        stackPosition: 4,
        parentId: "cs-03",
        branch: "community/zig-static-archive-hints",
        title: "feat(closure): track Zig static archive inputs in split targets",
        commitSha: "572c6e21abcd1234567890abcdef1234567890ef",
        author: "alice-dev",
        trustTier: "untrusted:community",
        auditScore: 96,
        gateSatisfied: false,
        state: "review",
        diffSummary: "+84 -12 (untrusted community preview awaiting controlled sandbox rerun)",
        updatedAt: "2026-11-26T23:47:00.000Z"
      }
    ]

    this.pulls = [
      {
        number: 101,
        title: "Smithers Cloud switchover: Lighthouse audit, Cloud MCP, Wiki, and Mythical History",
        body: "Stacks cs-01 through cs-03 to make smithers-ci a public flagship factory on smithers.sh/smithersai/smithers-ci.",
        branch: "stack/03-cloud-mcp-and-ott",
        baseBranch: "main",
        author: "roninjin10",
        authorContributions: 142,
        state: "open",
        changesetIds: ["cs-01", "cs-02", "cs-03"],
        trustTier: "trusted:sandbox",
        auditScore: 99,
        gateSatisfied: true,
        mirrorSyncedToGithub: true,
        createdAt: "2026-11-26T23:44:00.000Z"
      },
      {
        number: 102,
        title: "Track Zig static archive inputs during dependency closure",
        body: "Community PR tested locally with untrusted preview mode (96/100). Ready for maintainer controlled-sandbox re-verification.",
        branch: "community/zig-static-archive-hints",
        baseBranch: "main",
        author: "alice-dev",
        authorContributions: 3,
        state: "open",
        changesetIds: ["cs-04"],
        trustTier: "untrusted:community",
        auditScore: 96,
        gateSatisfied: false,
        mirrorSyncedToGithub: true,
        createdAt: "2026-11-26T23:47:00.000Z"
      }
    ]

    this.runs = [
      {
        id: "run-9041",
        flow: "ci",
        commitSha: "9e0efd0d871f1234567890abcdef1234567890ab",
        actor: "cfbox-gate-04",
        trustTier: "trusted:sandbox",
        status: "passed",
        auditScore: 99,
        durationMs: 3940,
        cacheHitRate: 0.94,
        startedAt: "2026-11-26T23:41:12.000Z"
      },
      {
        id: "run-9040",
        flow: "audit",
        commitSha: "46412bca49c3a0f1234567890abcdef123456789",
        actor: "roninjin10",
        trustTier: "trusted:maintainer",
        status: "passed",
        auditScore: 100,
        durationMs: 2890,
        cacheHitRate: 0.97,
        startedAt: "2026-11-26T23:39:00.000Z"
      },
      {
        id: "run-9039",
        flow: "untrusted-replay",
        commitSha: "572c6e21abcd1234567890abcdef1234567890ef",
        actor: "alice-dev",
        trustTier: "untrusted:community",
        status: "untrusted_preview",
        auditScore: 96,
        durationMs: 4210,
        cacheHitRate: 0.88,
        startedAt: "2026-11-26T23:47:15.000Z"
      }
    ]

    this.nextIssueNumber = 5
    this.nextPrNumber = 103
  }

  listTodos(): ReadonlyArray<TodoItem> {
    return this.todos
  }

  draftTodo(
    input: { readonly title: string; readonly body: string; readonly priority?: "P0" | "P1" | "P2"; readonly linkedIssue?: number | null },
    execution: VerifiedExecution
  ): TodoItem {
    const title = input.title.trim()
    if (title.length < 3 || title.length > 160) {
      throw new FactoryActionError("invalid", "TODO title must be 3 to 160 characters", 400)
    }
    const item: TodoItem = {
      id: `todo-${this.todos.length + 1}`,
      title,
      body: input.body.trim(),
      status: "draft",
      priority: input.priority ?? "P1",
      author: formatAttribution(execution),
      visibility: "public",
      linkedIssue: input.linkedIssue ?? null,
      createdAt: new Date().toISOString()
    }
    this.todos.unshift(item)
    return item
  }

  commitTodo(id: string, execution: VerifiedExecution): TodoItem {
    const auth = authorizeAction(execution, "todo/commit")
    if (!auth.allowed) {
      throw new FactoryActionError(
        auth.code === "person_only" ? "person_only" : "maintainer_required",
        auth.reason,
        403
      )
    }
    const idx = this.todos.findIndex((t) => t.id === id)
    if (idx === -1) {
      throw new FactoryActionError("not_found", `TODO ${id} not found`, 404)
    }
    const updated: TodoItem = { ...this.todos[idx]!, status: "committed" }
    this.todos[idx] = updated
    return updated
  }

  listIssues(): ReadonlyArray<IssueRecord> {
    return this.issues
  }

  getIssue(number: number): IssueRecord | null {
    return this.issues.find((i) => i.number === number) ?? null
  }

  createIssue(
    input: { readonly title: string; readonly body: string; readonly labels?: ReadonlyArray<string> },
    execution: VerifiedExecution
  ): IssueRecord {
    const title = input.title.trim()
    if (title.length < 3 || title.length > 200) {
      throw new FactoryActionError("invalid", "Issue title must be 3 to 200 characters", 400)
    }
    const safeLabels = (input.labels ?? []).filter((l) => !l.toLowerCase().startsWith("smithers:"))
    const issue: IssueRecord = {
      number: this.nextIssueNumber++,
      title,
      body: input.body.trim(),
      state: "open",
      triage: "untriaged",
      author: formatAttribution(execution),
      labels: safeLabels,
      comments: [],
      createdAt: new Date().toISOString()
    }
    this.issues.unshift(issue)
    return issue
  }

  commentIssue(number: number, body: string, execution: VerifiedExecution): IssueRecord {
    const issue = this.getIssue(number)
    if (!issue) {
      throw new FactoryActionError("not_found", `Issue #${number} not found`, 404)
    }
    issue.comments.push({
      author: formatAttribution(execution),
      body: body.trim(),
      at: new Date().toISOString()
    })
    return issue
  }

  listChangesets(): ReadonlyArray<ChangesetRecord> {
    return this.changesets
  }

  proposeChangeset(
    input: {
      readonly title: string
      readonly branch: string
      readonly parentId?: string | null
      readonly diffSummary: string
      readonly auditScore?: number
    },
    execution: VerifiedExecution
  ): ChangesetRecord {
    const score = input.auditScore ?? 95
    const record: ChangesetRecord = {
      id: `cs-${String(this.changesets.length + 1).padStart(2, "0")}`,
      stackPosition: this.changesets.length + 1,
      parentId: input.parentId ?? (this.changesets[this.changesets.length - 1]?.id ?? null),
      branch: input.branch.trim(),
      title: input.title.trim(),
      commitSha: execution.commitSha,
      author: formatAttribution(execution),
      trustTier: execution.effectiveTier,
      auditScore: score,
      gateSatisfied: execution.trusted && score >= 90,
      state: execution.trusted ? "review" : "draft",
      diffSummary: input.diffSummary.trim(),
      updatedAt: new Date().toISOString()
    }
    this.changesets.push(record)
    return record
  }

  listPulls(): ReadonlyArray<PullRequestRecord> {
    return this.pulls
  }

  getPull(number: number): PullRequestRecord | null {
    return this.pulls.find((p) => p.number === number) ?? null
  }

  draftPull(
    input: {
      readonly title: string
      readonly body: string
      readonly branch: string
      readonly baseBranch?: string
      readonly changesetIds?: ReadonlyArray<string>
      readonly auditScore?: number
    },
    execution: VerifiedExecution
  ): PullRequestRecord {
    const score = input.auditScore ?? 95
    const pr: PullRequestRecord = {
      number: this.nextPrNumber++,
      title: input.title.trim(),
      body: input.body.trim(),
      branch: input.branch.trim(),
      baseBranch: input.baseBranch ?? "main",
      author: formatAttribution(execution),
      authorContributions: execution.trusted ? 10 : 1,
      state: "open",
      changesetIds: input.changesetIds ?? [],
      trustTier: execution.effectiveTier,
      auditScore: score,
      gateSatisfied: execution.trusted && score >= 90,
      mirrorSyncedToGithub: true,
      createdAt: new Date().toISOString()
    }
    this.pulls.unshift(pr)
    return pr
  }

  mergePull(number: number, execution: VerifiedExecution): PullRequestRecord {
    const auth = authorizeAction(execution, "pr/merge")
    if (!auth.allowed) {
      throw new FactoryActionError(
        auth.code === "person_only" ? "person_only" : "maintainer_required",
        auth.reason,
        403
      )
    }
    const idx = this.pulls.findIndex((p) => p.number === number)
    if (idx === -1) {
      throw new FactoryActionError("not_found", `Pull request #${number} not found`, 404)
    }
    const pr = this.pulls[idx]!
    if (!pr.gateSatisfied) {
      throw new FactoryActionError(
        "gate_not_satisfied",
        `PR #${number} cannot merge until a trusted sandbox or maintainer satisfies the backpressure gate (current trust: ${pr.trustTier}).`,
        409
      )
    }
    const merged: PullRequestRecord = { ...pr, state: "merged" }
    this.pulls[idx] = merged
    return merged
  }

  listRuns(): ReadonlyArray<FactoryRunRecord> {
    return this.runs
  }

  recordRun(run: FactoryRunRecord): void {
    this.runs.unshift(run)
  }
}
