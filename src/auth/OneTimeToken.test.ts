import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  OneTimeTokenStore,
  computePkceS256Challenge,
  formatBootstrapEnvelope,
  intersectScopes,
  writeTokenFile
} from "./OneTimeToken.ts"

describe("OneTimeTokenStore", () => {
  it("mints a single-use token, burns it on first redemption, and rejects replay", () => {
    let clock = new Date("2026-11-27T08:00:00.000Z")
    const store = new OneTimeTokenStore({ now: () => clock })

    const verifier = "pkce-verifier-random-string-0123456789abcdef"
    const challenge = computePkceS256Challenge(verifier)

    const minted = store.mint({
      repository: "smithersai/smithers-ci",
      subject: "sandbox:cfbox-42",
      mintedBy: "roninjin10",
      trustTier: "trusted:sandbox",
      scopes: ["mcp:read", "mcp:write", "cache:write", "artifact:write:trusted", "pr/merge", "secrets/write"],
      sandboxId: "cfbox-42",
      pkceChallenge: challenge,
      ttlSeconds: 300
    })

    expect(minted.rawToken).toMatch(/^smo_[0-9a-f]{64}$/)
    expect(minted.scopes).toEqual(["mcp:read", "mcp:write", "cache:write", "artifact:write:trusted"])
    expect(minted.strippedScopes).toEqual(["pr/merge", "secrets/write"])

    // Wrong PKCE verifier rejected without burning token
    const wrongPkce = store.redeem({
      rawToken: minted.rawToken,
      repository: "smithersai/smithers-ci",
      pkceVerifier: "wrong-verifier"
    })
    expect(wrongPkce.ok).toBe(false)
    if (!wrongPkce.ok) expect(wrongPkce.code).toBe("pkce_mismatch")

    // Correct PKCE verifier succeeds once
    const first = store.redeem({
      rawToken: minted.rawToken,
      repository: "smithersai/smithers-ci",
      pkceVerifier: verifier
    })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("expected first redeem ok")
    expect(first.lease.rawLeaseToken).toMatch(/^sms_[0-9a-f]{64}$/)

    // Second redemption ALWAYS fails with already_redeemed
    const replay = store.redeem({
      rawToken: minted.rawToken,
      repository: "smithersai/smithers-ci",
      pkceVerifier: verifier
    })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.code).toBe("already_redeemed")

    // Lease verifies until revoked or expired
    expect(store.verifyLease(first.lease.rawLeaseToken, "smithersai/smithers-ci")?.leaseId).toBe(
      first.lease.leaseId
    )
    expect(store.verifyLease(first.lease.rawLeaseToken, "other/repo")).toBeNull()
    expect(store.revokeLease(first.lease.leaseId)).toBe(true)
    expect(store.verifyLease(first.lease.rawLeaseToken, "smithersai/smithers-ci")).toBeNull()

    // Audit summary never exposes raw token or digest
    const summaries = store.listAuditSummaries()
    expect(summaries).toHaveLength(1)
    expect(JSON.stringify(summaries)).not.toContain(minted.rawToken)
    expect(JSON.stringify(summaries)).not.toContain(minted.digest)

    // Bootstrap envelope formats cleanly
    const envelope = formatBootstrapEnvelope(minted)
    expect(envelope).toContain(minted.id)
    expect(envelope).toContain("Single Use:   yes")
  })

  it("strips privileged cache/gate scopes from untrusted:community tokens", () => {
    const { granted, stripped } = intersectScopes(
      ["mcp:read", "cache:read", "cache:write", "gate:satisfy", "artifact:write:trusted", "artifact:write:untrusted", "todo:draft", "todo/commit"],
      "untrusted:community"
    )
    expect(granted).toEqual(["mcp:read", "cache:read", "artifact:write:untrusted", "todo:draft"])
    expect(stripped).toEqual(["cache:write", "gate:satisfy", "artifact:write:trusted", "todo/commit"])
  })

  it("writes mode-600 token files and refuses overwriting existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-token-"))
    const store = new OneTimeTokenStore()
    const minted = store.mint({
      repository: "smithersai/smithers-ci",
      subject: "agent:ci-worker",
      mintedBy: "roninjin10",
      trustTier: "trusted:sandbox",
      scopes: ["mcp:read", "audit:run"]
    })

    const outPath = join(dir, "sandbox-token")
    const { tokenPath, receiptPath } = writeTokenFile(outPath, minted)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600)
    expect(() => writeTokenFile(outPath, minted)).toThrow(/overwrite/)
  })
})
