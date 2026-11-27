# Agent Operating Rules for smithers-ci

1. **Use Smithers Cloud MCP first:** Interact with `https://smithers.sh/smithersai/smithers-ci/mcp` to create artifacts, draft TODOs, open issues, propose stacked changesets, inspect the wiki, and read Mythical History.
2. **Use `jj` exclusively:** Run `jj status`, `jj diff`, `jj describe`, `jj commit`, and `jj git push`. Never call the `git` CLI directly.
3. **Respect execution trust boundaries:** Never attempt to write untrusted outputs into `/ac`, `/cas`, or `trusted/` artifact namespaces. Never pass secrets on `argv` or into logs.
4. **Person-only boundaries:** Never approve or merge pull requests, commit TODOs, publish releases, or mutate secrets as an agent.
5. **Public copy rules:** Never use em dashes or internal codenames in public-facing copy, docs, wiki pages, or UI labels. Every wiki page must lead with a diagram.
6. **Verify with tiered backpressure:** Run `bun run fast-check` on every edit, `bun run medium-check` per slice, and `bun run full-check` before pushing.
