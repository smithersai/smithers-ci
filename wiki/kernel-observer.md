---
title: Kernel Observer (smthrs-observe)
summary: How smthrs-observe records exact file reads at the Linux seccomp-unotify boundary inside bubblewrap for zero stale passes.
owner: smithers-ci
---

# Kernel Observer (smthrs-observe)

```text
+---------------------------------------------------------------+
|  bubblewrap jail (unprivileged user, isolated mount/net ns)   |
|    +-------------------------------------------------------+  |
|    |  CI Step Process (node, zig, cargo, go, pytest, ...)  |  |
|    +---------------------------+---------------------------+  |
|                                | openat / statx / execve      |
|                                v                              |
|    +-------------------------------------------------------+  |
|    |  Linux seccomp-unotify -> smthrs-observe (record /7)  |  |
|    +---------------------------+---------------------------+  |
+--------------------------------|------------------------------+
                                 v
             Exact SHA-256 Read Closure -> Shared CAS Key
```

Hand-maintained glob patterns always go stale. Miss one config file and CI silently passes on broken code. Over-declare a glob and every unrelated edit blows away the cache.

`smthrs-observe` eliminates hand-maintained globs by intercepting filesystem and network boundary syscalls directly from the Linux kernel.

## Key Guarantees

- **Zero stale passes:** Every opened file, directory link count, missing-path probe, and spawned binary enters the action cache key.
- **Network escapes cannot poison cache:** Any step that reaches a network socket (including UDP send or blocked `io_uring_setup`) is marked non-cacheable so remote state never masquerades as a pure hit.
- **Record format `/7`:** Rebuilt cleanly with `-Wall -Werror` for both `x86_64` and `aarch64`, with 100 percent coverage across all four observer modules and verified live against Lean 4 specs.
- **Clean macOS fallback:** On macOS runners where Linux seccomp is absent, steps still execute cleanly and background daemons left running for later steps are handled cleanly.

## Related Pages

- [[incremental-replay]]
- [[shared-object-store]]
- [[formal-verification]]
- [[index]]
