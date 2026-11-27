import React, { useState } from "react"

interface RepoBenchmark {
  readonly id: string
  readonly repo: string
  readonly ecosystem: string
  readonly trustMode: "trusted:sandbox" | "untrusted:sandbox-only"
  readonly baselineSeconds: number
  readonly cachedSeconds: number
  readonly speedupLabel: string
  readonly mismatches: number
  readonly summary: string
  readonly command: string
}

const REPO_BENCHMARKS: ReadonlyArray<RepoBenchmark> = [
  {
    id: "smithers-ci-example",
    repo: "smithersai/smithers-ci-example",
    ecosystem: "Node / Multi-package",
    trustMode: "trusted:sandbox",
    baselineSeconds: 12.9,
    cachedSeconds: 2.9,
    speedupLabel: "4.4x faster (docs) / 1.3x (code)",
    mismatches: 0,
    summary: "Kernel-recorded smthrs-observe discovers cross-package imports with zero hand-maintained globs. 4/4 steps reused on docs edits.",
    command: "bunx smithers-ci --commits 4"
  },
  {
    id: "zevm",
    repo: "evmts/zevm",
    ecosystem: "Zig + C ABI + N-API",
    trustMode: "trusted:sandbox",
    baselineSeconds: 68.4,
    cachedSeconds: 11.2,
    speedupLabel: "6.1x faster on unchanged Zig suites",
    mismatches: 0,
    summary: "Dogfooding Smithers CI on ZEVM: per-subsystem Zig targets key on pinned sibling sources and replay warm hits from build.smithers.sh.",
    command: "smthrs ci //..."
  },
  {
    id: "vibelang",
    repo: "smithersai/vibelang",
    ecosystem: "Go + TypeScript + VibeLang",
    trustMode: "trusted:sandbox",
    baselineSeconds: 142.0,
    cachedSeconds: 24.6,
    speedupLabel: "5.8x faster affected shard replay",
    mismatches: 0,
    summary: "Full coding factory with VIP review gates, incremental compiler test shards, Obsidian wiki, and Mythical History export.",
    command: "smthrs affected //..."
  },
  {
    id: "needlefish",
    repo: "smithersai/needlefish",
    ecosystem: "Zig (25 CI jobs)",
    trustMode: "trusted:sandbox",
    baselineSeconds: 49.5,
    cachedSeconds: 16.4,
    speedupLabel: "3.0x faster (0 apply refusals)",
    mismatches: 0,
    summary: "25 GitHub Actions jobs inventoried cleanly with 0 refusals and 0 mismatches under native smthrs-observe.",
    command: "smithers-ci replay --commits 2 --job test.yml:tidy"
  },
  {
    id: "eliza",
    repo: "elizaOS/eliza",
    ecosystem: "Untrusted External Repo",
    trustMode: "untrusted:sandbox-only",
    baselineSeconds: 31.2,
    cachedSeconds: 18.7,
    speedupLabel: "Isolated Cloudflare microVM",
    mismatches: 0,
    summary: "Strictly executed inside an ephemeral Cloudflare Sandbox (6.18.64-cloudflare-microvm + bwrap 0.8.0) with zero host clone, zero host secrets, and zero shared cache writes.",
    command: "node scripts/box-replay.mjs https://github.com/elizaOS/eliza 78e44531"
  }
]

export function ReplayShowcaseCard() {
  const [selectedId, setSelectedId] = useState<string>("smithers-ci-example")
  const active = REPO_BENCHMARKS.find((b) => b.id === selectedId) ?? REPO_BENCHMARKS[0]!
  const maxSec = Math.max(active.baselineSeconds, 1)
  const cachedPct = Math.max(8, Math.round((active.cachedSeconds / maxSec) * 100))

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Dogfooding Smithers CI Across Real Repositories</h2>
          <p className="card-sub">
            Click any repository to inspect kernel-recorded replay speedup, mismatch count, and execution trust isolation
          </p>
        </div>
        <span className={`pill ${active.trustMode === "trusted:sandbox" ? "pill-pass" : "pill-warn"}`}>
          {active.trustMode === "trusted:sandbox" ? "TRUSTED SANDBOX" : "CLOUDFLARE SANDBOX ONLY"}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "1rem" }}>
        {REPO_BENCHMARKS.map((item) => (
          <button
            key={item.id}
            className={`btn btn-sm ${item.id === active.id ? "btn-primary" : ""}`}
            onClick={() => setSelectedId(item.id)}
          >
            {item.repo}
          </button>
        ))}
      </div>

      <div className="grid-2" style={{ alignItems: "center" }}>
        <div className="stat-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>{active.repo}</strong>
            <span className="pill">{active.ecosystem}</span>
          </div>
          <p style={{ margin: "0.55rem 0 0.75rem", color: "var(--muted)", fontSize: "0.84rem" }}>
            {active.summary}
          </p>
          <pre className="code-block" style={{ padding: "0.6rem 0.75rem", fontSize: "0.78rem" }}>
            {active.command}
          </pre>
        </div>

        <div className="stat-card">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>Replay comparison</span>
            <strong style={{ color: "var(--lh-pass)", fontSize: "0.85rem" }}>{active.speedupLabel}</strong>
          </div>

          <div style={{ marginBottom: "0.7rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "0.2rem" }}>
              <span>Baseline cold CI</span>
              <code>{active.baselineSeconds.toFixed(1)}s</code>
            </div>
            <div style={{ height: "12px", borderRadius: "999px", background: "var(--surface)", overflow: "hidden" }}>
              <div style={{ width: "100%", height: "100%", background: "#64748b", borderRadius: "999px" }} />
            </div>
          </div>

          <div style={{ marginBottom: "0.85rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "0.2rem" }}>
              <span>Smithers CI cached</span>
              <code style={{ color: "var(--lh-pass)" }}>{active.cachedSeconds.toFixed(1)}s</code>
            </div>
            <div style={{ height: "12px", borderRadius: "999px", background: "var(--surface)", overflow: "hidden" }}>
              <div style={{ width: `${cachedPct}%`, height: "100%", background: "var(--lh-pass)", borderRadius: "999px", transition: "width 280ms ease" }} />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--muted)" }}>
            <span>Mismatches: <strong style={{ color: "var(--lh-pass)" }}>{active.mismatches}</strong></span>
            <span>Recorder: <code>smthrs-observe /7</code></span>
          </div>
        </div>
      </div>
    </section>
  )
}
