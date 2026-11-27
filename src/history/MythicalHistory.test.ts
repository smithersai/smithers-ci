import { describe, expect, it } from "vitest"
import { MythicalHistorySequencer, verifyMythicalHistory } from "./MythicalHistory.ts"

describe("MythicalHistorySequencer", () => {
  it("enforces deterministic linear ordering, idempotent folds, and verifiable export manifests", () => {
    const seq = new MythicalHistorySequencer()
    expect(seq.apply({ type: "epic.add", id: "e1", title: "Core Observer", summary: "Kernel capture" }).ok).toBe(true)
    expect(seq.apply({ type: "commit.plan", epicId: "e1", title: "Build smthrs-observe" }).ok).toBe(true)
    expect(seq.apply({ type: "commit.start", id: "m1", lane: "sci-observe" }).ok).toBe(true)
    expect(seq.apply({ type: "commit.note", id: "m1", section: "tried", text: "strace fallback overhead measured" }).ok).toBe(true)
    expect(seq.apply({ type: "commit.approve", id: "m1", by: "roninjin10" }).ok).toBe(true)

    const sha = "0617b070eb120000000000000000000000000000"
    expect(seq.apply({ type: "commit.fold", id: "m1", sha, message: "feat: record format /7" }).ok).toBe(true)
    const seqBefore = seq.snapshot().seq
    // Folding the same commit again is idempotent
    expect(seq.apply({ type: "commit.fold", id: "m1", sha, message: "feat: record format /7" }).ok).toBe(true)
    expect(seq.snapshot().seq).toBe(seqBefore)

    const snap = seq.snapshot()
    expect(verifyMythicalHistory(snap).valid).toBe(true)
    expect(snap.commits[0]?.foldedRealCommits).toHaveLength(1)

    const manifest1 = seq.exportManifest()
    const manifest2 = seq.exportManifest()
    expect(manifest1.manifestDigest).toBe(manifest2.manifestDigest)
    expect(manifest1.refs.mythicalBookmark).toBe("refs/heads/mythical")
  })
})
