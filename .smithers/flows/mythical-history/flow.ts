import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const historyVerify = CiJob.make("verify-history", {
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "verify-mythical-history", run: "bun run history:verify" }
  ]
})

export default Flow.make("mythical-history", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String
  },
  success: Schema.Struct({
    historyVerify: CiJob.Result
  }),
  body: (run) =>
    Node.all({
      historyVerify: historyVerify.call(run)
    })
})
