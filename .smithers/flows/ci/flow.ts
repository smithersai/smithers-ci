import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const fastCheck = CiJob.make("fast-check", {
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "typecheck-and-tests", run: "bun run fast-check" }
  ]
})

const mediumAudit = CiJob.make("lighthouse-audit", {
  needs: ["fast-check"],
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "wiki-home-history", run: "bun run wiki:check && bun run home:check && bun run history:verify" },
    { name: "lighthouse-backpressure", run: "bun run audit" },
    {
      name: "upload-lighthouse-artifacts",
      run: "curl -fsS -X PUT --data-binary @.smithers/reports/lighthouse-audit.json http://artifacts.smithers.internal/lighthouse-audit.json || true"
    }
  ]
})

export default Flow.make("ci", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String
  },
  success: Schema.Struct({
    fastCheck: CiJob.Result,
    mediumAudit: CiJob.Result
  }),
  body: (run) =>
    Node.all({
      fastCheck: fastCheck.call(run),
      mediumAudit: mediumAudit.call(run)
    })
})
