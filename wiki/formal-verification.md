---
title: Formal Verification and Fuzz Assurance
summary: Lean 4 formal specifications, differential fuzzing, and adversarial security test suites backing Smithers CI.
owner: smithers-ci
---

# Formal Verification and Fuzz Assurance

```text
  Lean 4 Reference Models (6 packages, 51 .lean files, 387 theorems, 0 sorry)
      |
      +-- inventory       +-- decompose       +-- select_shard
      +-- generate_apply  +-- report_replay   +-- observed_reads
      |
      v
  Differential Fuzzing (~55,685 queries) + 40 Adversarial Fuzz Suites
      |
      v
  Zero-Bypass Trust, Token, CAS, XSS, and Home.read Property Checks
```

Speed means nothing if a cache ever returns a stale pass or a trust boundary ever leaks a write credential. Smithers CI pairs kernel-level observation with formal verification and continuous fuzzing.

## Verified Engineering Receipts

- **Six Lean 4.32.0 packages:** `inventory`, `decompose`, `select_shard`, `generate_apply`, `report_replay`, and `observed_reads` across 51 `.lean` files totaling **387 machine-checked theorems with 0 `sorry`**.
- **Differential fuzzing:** Approximately **55,685 differential queries** compare the live runtime directly against the Lean models, catching edge cases in YAML merge key quoting, glob ranges, ANSI stripping, and credential redaction.
- **Three-round tri-model audit:** Every source module underwent 18 deep passes across Codex Astra, Claude Fable/Opus, and Gemini Neon, driving total findings down 81 percent from 441 to 82 and clearing all 7 P0 release blockers.
- **Control-plane security suites:** Local tests verify constant-time HMAC downgrade on forged claims, atomic single-use token burning, CAS tampering rejection, XSS entity escaping, and strict `@smthrs/views` `Home.read` bounds.

## Related Pages

- [[kernel-observer]]
- [[lighthouse-backpressure]]
- [[trust-and-isolation]]
- [[index]]
