import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { signExecutionClaim, verifyExecutionTrust } from "../trust/ExecutionTrust.ts"
import { ObjectStoreError, SharedObjectStore } from "./ObjectStore.ts"
import { sha256Hex } from "../auth/OneTimeToken.ts"

const SECRET = "object-store-test-signing-secret-abcdef"
const SHA = "9e0efd0d871f1234567890abcdef1234567890ab"
const NOW = new Date("2026-11-27T08:00:00.000Z")

function makeTrustedSandbox() {
  const claim = signExecutionClaim(
    {
      tier: "trusted:sandbox",
      callerKind: "sandbox",
      actor: "ci-worker",
      repository: "smithersai/smithers-ci",
      commitSha: SHA,
      sandboxId: "cfbox-99",
      issuedAt: "2026-11-27T07:55:00.000Z",
      expiresAt: "2026-11-27T08:30:00.000Z"
    },
    SECRET
  )
  return verifyExecutionTrust(claim, { signingSecret: SECRET, now: () => NOW })
}

function makeUntrustedCommunity() {
  return verifyExecutionTrust(
    {
      tier: "untrusted:community",
      callerKind: "person",
      actor: "contributor-bob",
      repository: "smithersai/smithers-ci",
      commitSha: SHA,
      issuedAt: "2026-11-27T07:55:00.000Z",
      expiresAt: "2026-11-27T08:30:00.000Z"
    },
    { signingSecret: SECRET, now: () => NOW }
  )
}

describe("SharedObjectStore", () => {
  it("allows trusted sandboxes to populate /ac and /cas and lets untrusted runs read warm hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-store-"))
    const store = new SharedObjectStore({ rootDir: dir })
    const trusted = makeTrustedSandbox()
    const untrusted = makeUntrustedCommunity()

    const actionKey = sha256Hex("test-target-v1")
    const entry = store.putActionCache(actionKey, "pass 120ms", { exitCode: 0, durationMs: 120 }, trusted)
    expect(entry.trustTier).toBe("trusted:sandbox")

    // Untrusted community run gets warm cache hits
    const hit = store.getActionCache(actionKey)
    expect(hit).not.toBeNull()
    expect(hit?.payload.toString("utf8")).toBe("pass 120ms")

    // Untrusted community run CANNOT poison /ac or /cas
    expect(() =>
      store.putActionCache(actionKey, "poisoned-pass", { exitCode: 0, durationMs: 1 }, untrusted)
    ).toThrow(ObjectStoreError)

    expect(() => store.putCas("poison-blob", untrusted)).toThrow(ObjectStoreError)
  })

  it("isolates untrusted artifacts from trusted artifacts without overwriting trusted pointers", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-artifacts-"))
    const store = new SharedObjectStore({ rootDir: dir })
    const trusted = makeTrustedSandbox()
    const untrusted = makeUntrustedCommunity()

    const trustedMeta = store.putArtifact("audit-report.json", JSON.stringify({ score: 98 }), {
      contentType: "application/json",
      execution: trusted
    })
    const untrustedMeta = store.putArtifact("audit-report.json", JSON.stringify({ score: 100 }), {
      contentType: "application/json",
      execution: untrusted
    })

    expect(trustedMeta.key).toBe(`trusted/${SHA}/audit-report.json`)
    expect(untrustedMeta.key).toBe(`untrusted/contributor-bob/${SHA}/audit-report.json`)
    expect(store.listArtifacts({ trustedOnly: true })).toHaveLength(1)
    expect(store.listArtifacts()).toHaveLength(2)

    const fetchedTrusted = store.getArtifact(trustedMeta.key)
    expect(JSON.parse(fetchedTrusted!.data.toString("utf8")).score).toBe(98)
  })

  it("detects corrupted CAS objects with integrity_mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ci-corrupt-"))
    const store = new SharedObjectStore({ rootDir: dir })
    const trusted = makeTrustedSandbox()
    const digest = store.putCas("original-bytes", trusted)

    // Corrupt file on disk
    writeFileSync(join(dir, "cas", digest), "tampered-bytes")
    expect(() => store.getCas(digest)).toThrow(/integrity check failed/)
  })
})
