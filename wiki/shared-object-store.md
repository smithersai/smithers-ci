---
title: Shared Smithers Cloud Object Store
summary: Content-addressed /ac and /cas build cache plus R2 CI artifact storage with strict trust-based read and write separation.
owner: smithers-ci
---

# Shared Smithers Cloud Object Store

```text
  Trusted Sandbox / Maintainer           Untrusted Community Runner
  (SMITHERS_CACHE_WRITE_TOKEN)           (SMITHERS_CACHE_READ_TOKEN only)
              |                                        |
              | PUT /ac, PUT /cas                      | GET /ac, GET /cas (Warm Hits!)
              | PUT trusted/<sha>/<artifact>           | PUT untrusted/<actor>/<sha>/<artifact>
              v                                        v
  +-------------------------------------------------------------------+
  |   Shared Smithers Cloud Object Store (https://build.smithers.sh)  |
  |   - Content-Addressed Blobs (/cas/<sha256>)                       |
  |   - Action Cache Verdicts   (/ac/<action-key>)                    |
  |   - Trusted Artifact Index  (trusted/<sha>/*)                     |
  |   - Isolated Community Area (untrusted/<actor>/<sha>/*)           |
  +-------------------------------------------------------------------+
```

Every repository running on Smithers Cloud shares one content-addressed object store at `https://build.smithers.sh`, paired with per-run R2 artifact storage (`http://artifacts.smithers.internal/<name>` inside Cloudflare job boxes).

## Integrity and Isolation Rules

1. **SHA-256 verification on every read:** Every CAS blob is re-hashed on read. Any tampered or corrupted object fails immediately with `integrity_mismatch`.
2. **Split credentials by design:** Read tokens are safe for public and community workflows so contributors enjoy instant warm cache hits. Write tokens exist only inside controlled Smithers sandboxes and maintainer workflows.
3. **Zero pointer collision:** Trusted Lighthouse reports, coverage receipts, and release tarballs live under `trusted/<sha>/`. Untrusted community outputs always route to `untrusted/<actor>/<sha>/` and can never overwrite a trusted artifact.

## Related Pages

- [[trust-and-isolation]]
- [[lighthouse-backpressure]]
- [[release-and-mirror]]
- [[index]]
