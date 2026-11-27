// Smithers Cloud workspace declaration for smithersai/smithers-ci.
// Uses the shared Smithers Cloud object store (https://build.smithers.sh)
// with split read/write credentials so untrusted community runs get instant
// warm cache reads while write privileges stay restricted to controlled
// sandboxes and maintainers.
export const Workspace = {
  name: "smithersai-smithers-ci",
  repository: "smithersai/smithers-ci",
  cache: {
    directory: ".smithers/cache",
    hostDirectories: ["node_modules", ".smithers/object-store"],
    remote: {
      endpoint: "https://build.smithers.sh",
      readSecret: "SMITHERS_CACHE_READ_TOKEN",
      writeSecret: "SMITHERS_CACHE_WRITE_TOKEN"
    }
  },
  artifacts: {
    internalEndpoint: "http://artifacts.smithers.internal",
    publicApi: "https://smithers.sh/api/repos/smithersai/smithers-ci/artifacts",
    trustedPrefix: "trusted/",
    untrustedPrefix: "untrusted/"
  },
  host: {
    bins: ["node", "bun", "pnpm", "jj", "bwrap", "strace"]
  },
  discovery: {
    prune: [
      "node_modules",
      "dist",
      ".flows",
      ".smithers/cache",
      ".smithers/object-store",
      ".smithers/reports",
      ".smithers/reports-untrusted",
      ".smithers/tokens"
    ]
  }
} as const
