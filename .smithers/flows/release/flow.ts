import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const gate = CiJob.make("release-gate", {
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "full-check", run: "bun run full-check" }
  ]
})

const pack = CiJob.make("pack-candidate", {
  needs: ["release-gate"],
  steps: [
    { name: "install", run: "bun install --frozen-lockfile" },
    { name: "pack-tarball", run: "npm pack --dry-run" }
  ]
})

export default Flow.make("release", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String
  },
  success: Schema.Struct({
    gate: CiJob.Result,
    pack: CiJob.Result
  }),
  body: (run) =>
    Node.all({
      gate: gate.call(run),
      pack: pack.call(run)
    })
})
