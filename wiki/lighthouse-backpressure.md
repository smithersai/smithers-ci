---
title: Lighthouse Backpressure Audit Report
summary: How Smithers CI grades every commit across six backpressure categories from 0 to 100 in a self-contained Lighthouse-inspired report.
owner: smithers-ci
---

# Lighthouse Backpressure Audit Report

```text
+-------------------------------------------------------------------------+
|  OVERALL BACKPRESSURE SCORE (0 - 100)   [TRUSTED / UNTRUSTED BANNER]    |
+-------------------------------------------------------------------------+
|  (99) Correctness   (99) Cache & Speed   (100) Security & Trust         |
|  (98) Formal/Fuzz   (100) Wiki & Docs    (100) Cloud Release            |
+-------------------------------------------------------------------------+
|  Expandable Audits  |  Timing Waterfall  |  Root-Input-Tracing Table    |
+-------------------------------------------------------------------------+
```

Plain CI logs hide signal behind thousands of lines of scrollback. Smithers CI renders every backpressure run as a special audit report modeled directly on Google Lighthouse.

## Six Weighted Categories

1. **Correctness & Determinism:** Strict TypeScript check, unit and protocol tests, zero-mismatch replay parity, and public copy hygiene.
2. **Cache & Speed:** Shared object store wiring (`build.smithers.sh`), granular affected-only `PACKAGE.ts` targets, and warm speedup ratio.
3. **Security & Trust Isolation:** Untrusted cache-poisoning immunity, trusted-only gate enforcement, single-use sandbox tokens, and root-input tracing.
4. **Formal & Fuzz Assurance:** Lean 4 theorem verification count (387 theorems, 0 `sorry`) and adversarial fuzz suite status.
5. **Wiki & Docs Freshness:** Obsidian wiki catalog completeness, zero broken `[[wikilinks]]`, visual-first diagrams, and Mythical History verification.
6. **Release & Cloud Readiness:** Personalized `.smithers/home.json` validation across all three audiences, v1 Cloud triggers, mirror workflows, and Cloud MCP health.

## Threshold Semantics

- **90 to 100 (Green):** Pass. Eligible to clear release and merge gates when produced by a trusted sandbox or maintainer.
- **50 to 89 (Amber):** Needs improvement. Surfaces actionable remediation steps directly inside each diagnostic row.
- **0 to 49 (Red):** Fail. Blocks release and merge gates.

## Related Pages

- [[trust-and-isolation]]
- [[shared-object-store]]
- [[formal-verification]]
- [[index]]
