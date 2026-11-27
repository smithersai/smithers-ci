import { createHash } from "node:crypto"

export type MythicalCommitState = "planned" | "working" | "approved" | "landed"
export type NoteSection = "tried" | "evidence" | "superseded"

export interface MythicalEpic {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly summary: string
}

export interface MythicalNote {
  readonly section: NoteSection
  readonly text: string
  readonly at: string
}

export interface MythicalCommit {
  readonly id: string
  readonly epicId: string
  readonly rank: number
  readonly title: string
  readonly state: MythicalCommitState
  readonly lane: string | null
  readonly notes: ReadonlyArray<MythicalNote>
  readonly foldedRealCommits: ReadonlyArray<{
    readonly sha: string
    readonly message: string
    readonly landedAt: string
  }>
}

export interface MythicalHistorySnapshot {
  readonly schemaVersion: "1.0.0"
  readonly repository: string
  readonly seq: number
  readonly epics: ReadonlyArray<MythicalEpic>
  readonly commits: ReadonlyArray<MythicalCommit>
}

export interface HistoryExportManifest {
  readonly repository: string
  readonly seq: number
  readonly refs: {
    readonly mythicalBookmark: "refs/heads/mythical"
    readonly notesRef: "refs/notes/mythical"
    readonly manifestRef: "refs/heads/smithers/history"
  }
  readonly manifestDigest: string
  readonly entries: ReadonlyArray<{
    readonly id: string
    readonly epicId: string
    readonly state: MythicalCommitState
    readonly parentId: string | null
    readonly foldedCount: number
    readonly deterministicHash: string
  }>
}

export type HistoryIntent =
  | { readonly type: "epic.add"; readonly id: string; readonly title: string; readonly summary: string }
  | { readonly type: "commit.plan"; readonly epicId: string; readonly title: string }
  | { readonly type: "commit.start"; readonly id: string; readonly lane: string }
  | { readonly type: "commit.note"; readonly id: string; readonly section: NoteSection; readonly text: string; readonly at?: string }
  | { readonly type: "commit.approve"; readonly id: string; readonly by: string; readonly at?: string }
  | { readonly type: "commit.fold"; readonly id: string; readonly sha: string; readonly message: string; readonly landedAt?: string }

export class MythicalHistorySequencer {
  private readonly repository: string
  private seq = 0
  private epics: MythicalEpic[] = []
  private commits: MythicalCommit[] = []
  private readonly foldedShas = new Set<string>()

  constructor(seed?: MythicalHistorySnapshot) {
    if (seed) {
      this.repository = seed.repository
      this.seq = seed.seq
      this.epics = [...seed.epics]
      this.commits = seed.commits.map((c) => ({
        ...c,
        notes: [...c.notes],
        foldedRealCommits: [...c.foldedRealCommits]
      }))
      for (const c of this.commits) {
        for (const real of c.foldedRealCommits) {
          this.foldedShas.add(real.sha.toLowerCase())
        }
      }
    } else {
      this.repository = "smithersai/smithers-ci"
    }
  }

  apply(intent: HistoryIntent): { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly refusal: string } {
    switch (intent.type) {
      case "epic.add": {
        if (this.epics.some((e) => e.id === intent.id)) {
          return { ok: false, refusal: `epic ${intent.id} already exists` }
        }
        this.seq += 1
        this.epics.push({
          id: intent.id,
          order: this.epics.length + 1,
          title: intent.title,
          summary: intent.summary
        })
        return { ok: true, seq: this.seq }
      }
      case "commit.plan": {
        if (!this.epics.some((e) => e.id === intent.epicId)) {
          return { ok: false, refusal: `unknown epic ${intent.epicId}` }
        }
        this.seq += 1
        const id = `m${this.commits.length + 1}`
        const epicCommits = this.commits.filter((c) => c.epicId === intent.epicId)
        this.commits.push({
          id,
          epicId: intent.epicId,
          rank: epicCommits.length + 1,
          title: intent.title,
          state: "planned",
          lane: null,
          notes: [],
          foldedRealCommits: []
        })
        return { ok: true, seq: this.seq }
      }
      case "commit.start": {
        const idx = this.commits.findIndex((c) => c.id === intent.id)
        if (idx === -1) return { ok: false, refusal: `unknown commit ${intent.id}` }
        const current = this.commits[idx]!
        if (current.state === "landed") return { ok: false, refusal: `commit ${intent.id} already landed` }
        this.seq += 1
        this.commits[idx] = { ...current, state: "working", lane: intent.lane }
        return { ok: true, seq: this.seq }
      }
      case "commit.note": {
        const idx = this.commits.findIndex((c) => c.id === intent.id)
        if (idx === -1) return { ok: false, refusal: `unknown commit ${intent.id}` }
        const current = this.commits[idx]!
        this.seq += 1
        this.commits[idx] = {
          ...current,
          notes: [
            ...current.notes,
            { section: intent.section, text: intent.text, at: intent.at ?? new Date().toISOString() }
          ]
        }
        return { ok: true, seq: this.seq }
      }
      case "commit.approve": {
        const idx = this.commits.findIndex((c) => c.id === intent.id)
        if (idx === -1) return { ok: false, refusal: `unknown commit ${intent.id}` }
        const current = this.commits[idx]!
        if (current.state === "landed") return { ok: false, refusal: `commit ${intent.id} already landed` }
        this.seq += 1
        this.commits[idx] = {
          ...current,
          state: "approved",
          notes: [
            ...current.notes,
            {
              section: "evidence",
              text: `Approved in person by ${intent.by}`,
              at: intent.at ?? new Date().toISOString()
            }
          ]
        }
        return { ok: true, seq: this.seq }
      }
      case "commit.fold": {
        const idx = this.commits.findIndex((c) => c.id === intent.id)
        if (idx === -1) return { ok: false, refusal: `unknown commit ${intent.id}` }
        const sha = intent.sha.trim().toLowerCase()
        if (this.foldedShas.has(sha)) {
          // Idempotent fold: already folded commits do not duplicate.
          return { ok: true, seq: this.seq }
        }
        const current = this.commits[idx]!
        this.seq += 1
        this.foldedShas.add(sha)
        this.commits[idx] = {
          ...current,
          state: "landed",
          foldedRealCommits: [
            ...current.foldedRealCommits,
            { sha, message: intent.message, landedAt: intent.landedAt ?? new Date().toISOString() }
          ]
        }
        return { ok: true, seq: this.seq }
      }
    }
  }

  snapshot(): MythicalHistorySnapshot {
    const epicOrder = new Map(this.epics.map((e) => [e.id, e.order]))
    const ordered = [...this.commits].sort((a, b) => {
      const eo = (epicOrder.get(a.epicId) ?? 999) - (epicOrder.get(b.epicId) ?? 999)
      return eo !== 0 ? eo : a.rank - b.rank
    })
    return {
      schemaVersion: "1.0.0",
      repository: this.repository,
      seq: this.seq,
      epics: [...this.epics],
      commits: ordered
    }
  }

  search(query: string): ReadonlyArray<MythicalCommit> {
    const q = query.trim().toLowerCase()
    if (!q) return this.snapshot().commits
    return this.snapshot().commits.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.notes.some((n) => n.text.toLowerCase().includes(q)) ||
        c.foldedRealCommits.some((r) => r.sha.includes(q) || r.message.toLowerCase().includes(q))
    )
  }

  exportManifest(): HistoryExportManifest {
    const snap = this.snapshot()
    let prevId: string | null = null
    let prevHash = "0".repeat(40)
    const entries = snap.commits.map((commit) => {
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            parent: prevHash,
            id: commit.id,
            epicId: commit.epicId,
            title: commit.title,
            state: commit.state,
            folded: commit.foldedRealCommits.map((f) => f.sha)
          })
        )
        .digest("hex")
        .slice(0, 40)
      const entry = {
        id: commit.id,
        epicId: commit.epicId,
        state: commit.state,
        parentId: prevId,
        foldedCount: commit.foldedRealCommits.length,
        deterministicHash: hash
      }
      prevId = commit.id
      prevHash = hash
      return entry
    })

    const manifestDigest = createHash("sha256").update(JSON.stringify(entries)).digest("hex")

    return {
      repository: snap.repository,
      seq: snap.seq,
      refs: {
        mythicalBookmark: "refs/heads/mythical",
        notesRef: "refs/notes/mythical",
        manifestRef: "refs/heads/smithers/history"
      },
      manifestDigest,
      entries
    }
  }
}

export function verifyMythicalHistory(snapshot: MythicalHistorySnapshot): {
  readonly valid: boolean
  readonly issues: ReadonlyArray<string>
} {
  const issues: string[] = []
  const epicIds = new Set(snapshot.epics.map((e) => e.id))
  const commitIds = new Set<string>()
  const foldedShas = new Set<string>()

  for (const commit of snapshot.commits) {
    if (!epicIds.has(commit.epicId)) {
      issues.push(`Commit ${commit.id} references unknown epic ${commit.epicId}`)
    }
    if (commitIds.has(commit.id)) {
      issues.push(`Duplicate mythical commit id ${commit.id}`)
    }
    commitIds.add(commit.id)
    for (const real of commit.foldedRealCommits) {
      const normalized = real.sha.toLowerCase()
      if (foldedShas.has(normalized)) {
        issues.push(`Real commit ${real.sha} folded into more than one mythical commit`)
      }
      foldedShas.add(normalized)
    }
  }

  return { valid: issues.length === 0, issues }
}
