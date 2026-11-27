import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const auditJob = CiJob.make("audit", {
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "run-lighthouse-audit", run: "bun run audit" }
  ]
})

export default Flow.make("audit", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String
  },
  success: Schema.Struct({
    audit: CiJob.Result
  }),
  body: (run) =>
    Node.all({
      audit: auditJob.call(run)
    })
})
