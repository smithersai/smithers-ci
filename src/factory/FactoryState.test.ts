import { describe, expect, it } from "vitest"
import { resolveAudience, seesSection, validateHomeJson } from "./Audience.ts"
import { FactoryActionError, FactoryState } from "./FactoryState.ts"
import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"

const SECRET = "factory-state-test-secret-0123456789"
const SHA = "46412bca49c3a0f1234567890abcdef123456789"
const NOW = new Date("2026-11-27T08:00:00.000Z")

describe("Audience Personalization & Home.read validation", () => {
  it("distinguishes maintainer, contributor (contributions >= 1), and viewer (0)", () => {
    const m = resolveAudience({ login: "roninjin10", contributions: 50 })
    expect(m.role).toBe("maintainer")
    expect(m.homeAudience).toBe("maintainer")
    expect(m.allowedViewAs).toEqual(["maintainer", "contributor", "viewer"])

    const c = resolveAudience({ login: "alice-dev", contributions: 1 })
    expect(c.role).toBe("contributor")
    expect(c.homeAudience).toBe("contributor")
    expect(c.allowedViewAs).toEqual(["contributor", "viewer"])

    const v = resolveAudience({ login: "bob-lurker", contributions: 0 })
    expect(v.role).toBe("viewer")
    expect(v.homeAudience).toBe("everyone")
    expect(v.allowedViewAs).toEqual(["viewer"])

    const anon = resolveAudience({ login: null, contributions: 0 })
    expect(anon.role).toBe("viewer")

    expect(seesSection("maintainer", "maintainer")).toBe(true)
    expect(seesSection("contributor", "maintainer")).toBe(false)
    expect(seesSection("contributor", "contributor")).toBe(true)
    expect(seesSection("everyone", "contributor")).toBe(false)
    expect(seesSection("everyone", "everyone")).toBe(true)
  })

  it("enforces @smthrs/views Home.read bounds and rejects HTML or unsafe URLs", () => {
    const valid = validateHomeJson(
      JSON.stringify({
        docs: "https://ci.smithers.sh/llms.txt",
        sections: [
          { title: "Today", audience: "maintainer", blocks: [{ type: "issues" }] },
          { title: "Contribute", audience: "contributor", blocks: [{ type: "text", text: "Open a PR." }] },
          {
            audience: "everyone",
            blocks: [{ type: "hero", title: "Smithers CI", tagline: "Fast CI for agents." }]
          }
        ]
      })
    )
    expect(valid.valid).toBe(true)
    expect(valid.audiences).toEqual(["maintainer", "contributor", "everyone"])

    const badHtml = validateHomeJson(
      JSON.stringify({
        blocks: [{ type: "text", text: "<b>no html</b>" }]
      })
    )
    expect(badHtml.valid).toBe(false)

    const badUrl = validateHomeJson(
      JSON.stringify({
        blocks: [{ type: "links", links: [{ label: "Bad", url: "javascript:alert(1)" }] }]
      })
    )
    expect(badUrl.valid).toBe(false)
  })
})

describe("FactoryState", () => {
  it("enforces person-only commits/merges and blocks merging untrusted PRs", () => {
    const factory = new FactoryState()

    const agentExec = verifyExecutionTrust(
      signExecutionClaim(
        {
          tier: "trusted:maintainer",
          callerKind: "agent",
          actor: "roninjin10",
          repository: "smithersai/smithers-ci",
          commitSha: SHA,
          issuedAt: "2026-11-27T07:55:00.000Z",
          expiresAt: "2026-11-27T08:30:00.000Z"
        },
        SECRET
      ),
      { signingSecret: SECRET, now: () => NOW }
    )

    const maintainerPerson = verifyExecutionTrust(
      signExecutionClaim(
        {
          tier: "trusted:maintainer",
          callerKind: "person",
          actor: "roninjin10",
          repository: "smithersai/smithers-ci",
          commitSha: SHA,
          issuedAt: "2026-11-27T07:55:00.000Z",
          expiresAt: "2026-11-27T08:30:00.000Z"
        },
        SECRET
      ),
      { signingSecret: SECRET, now: () => NOW }
    )

    const drafted = factory.draftTodo({ title: "Add Rust crate split", body: "Split cargo targets" }, agentExec)
    expect(drafted.author).toBe("roninjin10 (agent)")
    expect(drafted.status).toBe("draft")

    // Agent cannot commit TODO
    expect(() => factory.commitTodo(drafted.id, agentExec)).toThrow(FactoryActionError)

    // Maintainer in person CAN commit TODO
    const committed = factory.commitTodo(drafted.id, maintainerPerson)
    expect(committed.status).toBe("committed")

    // Agent cannot merge PR #101 even with trusted gate
    expect(() => factory.mergePull(101, agentExec)).toThrow(/person-only/)

    // Maintainer CANNOT merge untrusted PR #102 whose gate is unsatisfied
    expect(() => factory.mergePull(102, maintainerPerson)).toThrow(/cannot merge until/)

    // Maintainer CAN merge trusted PR #101
    const merged = factory.mergePull(101, maintainerPerson)
    expect(merged.state).toBe("merged")
  })
})
