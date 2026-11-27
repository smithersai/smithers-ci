// Smithers 1.0 incremental build graph for smithersai/smithers-ci.
// Stratifies fast-check (seconds), medium-check (audit + wiki + home + history),
// and full-check (UI build + full bundle) so unchanged targets replay from
// https://build.smithers.sh without rerunning.
export const Package = {
  name: "smithers-ci",
  targets: {
    typecheck: {
      kind: "check",
      command: "bun run typecheck",
      inputs: ["tsconfig.json", "src/**/*.ts", "app/src/**/*.{ts,tsx}", "worker/**/*.ts", "scripts/**/*.ts"]
    },
    test: {
      kind: "test",
      command: "bun run test",
      inputs: ["vitest.config.ts", "src/**/*.ts", "worker/**/*.ts"]
    },
    wikiCheck: {
      kind: "docs",
      command: "bun run wiki:check",
      inputs: ["wiki/**/*.md", "src/wiki/WikiEngine.ts", ".smithers/coding-project.json"]
    },
    homeCheck: {
      kind: "check",
      command: "bun run home:check",
      inputs: [".smithers/home.json", "src/factory/Audience.ts"]
    },
    historyVerify: {
      kind: "check",
      command: "bun run history:verify",
      inputs: ["history/mythical-history.json", "src/history/MythicalHistory.ts"]
    },
    audit: {
      kind: "audit",
      command: "bun run audit",
      deps: ["typecheck", "test", "wikiCheck", "homeCheck", "historyVerify"],
      outputs: [".smithers/reports/lighthouse-audit.json", ".smithers/reports/lighthouse-audit.html"]
    },
    buildUi: {
      kind: "build",
      command: "bun run build:ui",
      deps: ["audit"],
      inputs: ["app/**/*", "scripts/generate-snapshot.ts"],
      outputs: ["dist/ui/**"]
    },
    ci: {
      kind: "group",
      deps: ["typecheck", "test", "wikiCheck", "homeCheck", "historyVerify", "audit", "buildUi"]
    }
  }
} as const
