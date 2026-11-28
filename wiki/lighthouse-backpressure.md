---
title: Lighthouse Backpressure Audit Report
summary: How Smithers CI grades every commit across six backpressure categories from 0 to 100 in a self-contained Lighthouse-inspired report.
owner: smithers-ci
---

# Lighthouse Backpressure Audit Report

```text
+-------------------------------------------------------------------------+
|  OVERALL BACKPRESSURE SCORE (0 - 100)   [UNTRUSTED / TRUSTED BANNER]    |
+-------------------------------------------------------------------------+
|  Correctness        Cache & Speed        Security & Trust               |
|  Formal & Fuzz      Wiki & Docs          Cloud Release                  |
+-------------------------------------------------------------------------+
|  Expandable Audits  |  Timing Waterfall  |  Root-Input-Tracing Table    |
+-------------------------------------------------------------------------+
```

Plain CI logs hide signal behind thousands of lines of scrollback. Smithers CI renders every backpressure run as a self-contained audit report modeled directly on Google Lighthouse.

## Default Local Provenance and Honest Evidence

- **Actual checkout identity:** Running `bun run audit` resolves the real repository and commit SHA from local `jj` or `.git` metadata rather than substituting a fixed example commit.
- **Honest untrusted default:** Normal CLI audit runs default to `untrusted:community` (`UNTRUSTED COMMUNITY`, `untrusted_preview`, gate `NOT SATISFIED`) and isolate local artifacts under `untrusted/<actor>/<sha>/`.
- **No invented measurements:** Checks that were not executed in the audit invocation (such as typecheck, unit tests, replay parity, warm speedup, Lean 4 proofs, or fuzz suites) stay explicit `warn` rows marked `Not measured` instead of fabricating passing scores or timings.
- **Fail-closed elevation:** Requesting `trusted:sandbox` or `trusted:maintainer` fails closed until a production external trust-receipt verification adapter verifies a genuine externally issued receipt bound to the checkout commit.
- **Separate explicit examples:** Illustrative trusted examples live separately in `src/audit/ExampleAudit.ts` and are marked `isExample: true`.

## Six Weighted Categories

1. **Correctness & Determinism:** Strict TypeScript check, unit and protocol tests, zero-mismatch replay parity, and public copy hygiene.
2. **Cache & Speed:** Shared object store wiring (`build.smithers.sh`), granular affected-only `PACKAGE.ts` targets, and measured warm speedup ratio.
3. **Security & Trust Isolation:** Untrusted cache-poisoning immunity, trusted-only gate enforcement, single-use sandbox tokens, and root-input tracing.
4. **Formal & Fuzz Assurance:** Measured Lean 4 theorem verification results and adversarial fuzz suite execution status.
5. **Wiki & Docs Freshness:** Obsidian wiki catalog completeness, zero broken `[[wikilinks]]`, visual-first diagrams, and Mythical History verification.
6. **Release & Cloud Readiness:** Personalized `.smithers/home.json` validation across all three audiences, v1 Cloud triggers, mirror workflows, and Cloud MCP module presence.

## Threshold Semantics

- **90 to 100 (Green):** Pass. Eligible to clear release and merge gates only when produced with an externally verified trust receipt and measured passing checks.
- **50 to 89 (Amber):** Needs improvement or contains unmeasured checks. Surfaces actionable remediation steps directly inside each diagnostic row.
- **0 to 49 (Red):** Fail. Blocks release and merge gates.

## Related Pages

- [[trust-and-isolation]]
- [[shared-object-store]]
- [[formal-verification]]
- [[index]]
