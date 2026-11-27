import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const wikiCheck = CiJob.make("wiki-freshness", {
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "check-wiki", run: "bun run wiki:check" }
  ]
})

export default Flow.make("wiki", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String
  },
  success: Schema.Struct({
    wikiCheck: CiJob.Result
  }),
  body: (run) =>
    Node.all({
      wikiCheck: wikiCheck.call(run)
    })
})
