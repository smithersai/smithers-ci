import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const buildSite = CiJob.make("build-docs-and-ui", {
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "verify-wiki-and-history", run: "bun run wiki:check && bun run history:verify && bun run home:check" },
    { name: "build-factory-ui", run: "bun run build:ui" }
  ]
})

export default Flow.make("docs-publish", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String
  },
  success: Schema.Struct({
    buildSite: CiJob.Result
  }),
  body: (run) =>
    Node.all({
      buildSite: buildSite.call(run)
    })
})
