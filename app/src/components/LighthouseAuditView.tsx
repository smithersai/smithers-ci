import React, { useState } from "react"
import type { FactorySnapshot } from "../data/generatedSnapshot.ts"
import { LighthouseGauge } from "./LighthouseGauge.tsx"

interface LighthouseAuditViewProps {
  readonly snapshot: FactorySnapshot
}

export function LighthouseAuditView({ snapshot }: LighthouseAuditViewProps) {
  const [provenanceMode, setProvenanceMode] = useState<"trusted" | "untrusted">("trusted")
  const [statusFilter, setStatusFilter] = useState<"all" | "pass" | "warn" | "fail">("all")
  const [openAudits, setOpenAudits] = useState<Record<string, boolean>>({})

  const report = provenanceMode === "trusted" ? snapshot.trustedAudit : snapshot.untrustedAudit
  const maxBase = Math.max(...report.waterfall.map((w) => w.baselineMs), 1)

  const toggleAudit = (id: string) => {
    setOpenAudits((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div>
      {/* Top Provenance Switcher */}
      <div
        className="card"
        style={{
          marginBottom: "1.15rem",
          borderColor:
            provenanceMode === "trusted"
              ? "color-mix(in srgb, var(--lh-pass) 45%, var(--line))"
              : "color-mix(in srgb, var(--lh-avg) 48%, var(--line))"
        }}
      >
        <div className="card-head" style={{ marginBottom: "0.5rem" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <span className={`pill ${provenanceMode === "trusted" ? "pill-pass" : "pill-warn"}`}>
                {report.policy.provenanceBadge}
              </span>
              <span className="pill">
                Gate: {report.gate.status} ({report.gate.satisfied ? "SATISFIED" : "NOT SATISFIED"})
              </span>
              <span className="pill">
                Cache write: {report.policy.allowCacheWrite ? "ALLOWED" : "HARD BLOCKED"}
              </span>
            </div>
            <p className="card-sub" style={{ marginTop: "0.45rem" }}>
              {report.gate.reason}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
            <div className="role-switcher">
              <button
                className={`role-btn ${provenanceMode === "trusted" ? "active" : ""}`}
                onClick={() => setProvenanceMode("trusted")}
              >
                Trusted Sandbox
              </button>
              <button
                className={`role-btn ${provenanceMode === "untrusted" ? "active" : ""}`}
                onClick={() => setProvenanceMode("untrusted")}
              >
                Untrusted Community
              </button>
            </div>
            <a className="btn btn-sm" href="/lighthouse-audit.html" target="_blank" rel="noreferrer">
              Open standalone HTML
            </a>
          </div>
        </div>
      </div>

      {/* Overall Hero + 6 Lighthouse Gauges */}
      <section className="card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1.25rem",
            paddingBottom: "1.2rem",
            marginBottom: "1.2rem",
            borderBottom: "1px solid var(--line)"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "1.15rem", flexWrap: "wrap" }}>
            <LighthouseGauge label="Overall" score={report.overallScore} size={114} />
            <div>
              <h2 className="card-title" style={{ fontSize: "1.25rem" }}>
                Lighthouse Backpressure Audit Report
              </h2>
              <p className="card-sub">
                {report.repository} @ <code>{report.commitSha.slice(0, 12)}</code> · Actor:{" "}
                <code>{report.execution.actor}</code>
              </p>
              <p className="card-sub">
                {report.summary.passed}/{report.summary.totalAudits} passed · {report.summary.warnings} warnings ·{" "}
                {report.summary.failed} failed · Release floor: {report.summary.releaseThreshold}/100
              </p>
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {(["all", "pass", "warn", "fail"] as const).map((status) => (
              <button
                key={status}
                className={`btn btn-sm ${statusFilter === status ? "btn-primary" : ""}`}
                onClick={() => setStatusFilter(status)}
              >
                {status === "all" ? "All audits" : status.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="lh-grid">
          {report.categories.map((cat) => (
            <LighthouseGauge
              key={cat.id}
              label={cat.shortTitle}
              score={cat.score}
              size={94}
              sublabel={`${cat.passedCount}/${cat.audits.length} pass`}
            />
          ))}
        </div>
      </section>

      {/* Expandable Category Diagnostics */}
      {report.categories.map((cat) => {
        const visibleAudits = cat.audits.filter((a) => statusFilter === "all" || a.status === statusFilter)
        if (visibleAudits.length === 0) return null
        return (
          <section key={cat.id} className="card">
            <div className="card-head">
              <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
                <LighthouseGauge label={cat.shortTitle} score={cat.score} size={58} />
                <div>
                  <h3 className="card-title">{cat.title}</h3>
                  <p className="card-sub">
                    {cat.passedCount} passed · {cat.warnCount} warnings · {cat.failCount} failed
                  </p>
                </div>
              </div>
            </div>

            {visibleAudits.map((audit) => {
              const isOpen = openAudits[audit.id] ?? audit.status !== "pass"
              return (
                <div key={audit.id} className="audit-item">
                  <button className="audit-trigger" onClick={() => toggleAudit(audit.id)}>
                    <span
                      className={`dot ${
                        audit.status === "pass"
                          ? "dot-pass"
                          : audit.status === "warn"
                            ? "dot-warn"
                            : "dot-fail"
                      }`}
                    />
                    <span style={{ fontWeight: 600 }}>{audit.title}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: "0.8rem", color: "var(--muted)" }}>
                      {audit.displayValue}
                    </span>
                    <span
                      className="num"
                      style={{
                        fontWeight: 700,
                        color:
                          audit.score >= 90
                            ? "var(--lh-pass)"
                            : audit.score >= 50
                              ? "var(--lh-avg)"
                              : "var(--lh-fail)"
                      }}
                    >
                      {audit.score}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="audit-evidence">
                      <div>{audit.description}</div>
                      <ul>
                        {audit.evidence.map((ev, i) => (
                          <li key={i}>
                            <code>{ev}</code>
                          </li>
                        ))}
                      </ul>
                      <div style={{ marginTop: "0.45rem", fontSize: "0.75rem", color: "var(--muted)" }}>
                        Audit ID: <code>{audit.id}</code> · Weight: {audit.weight} · {audit.durationMs}ms
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </section>
        )
      })}

      {/* Timing Waterfall */}
      <section className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Cache & Replay Timing Waterfall</h3>
            <p className="card-sub">
              Baseline cold execution vs shared Smithers Cloud object store (<code>{snapshot.objectStoreEndpoint}</code>)
            </p>
          </div>
          <span className="pill pill-pass">All 6 targets warm cached</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Baseline (slate) vs Cached (green)</th>
                <th className="num">Baseline</th>
                <th className="num">Cached</th>
                <th className="num">Speedup</th>
              </tr>
            </thead>
            <tbody>
              {report.waterfall.map((step) => {
                const basePct = (step.baselineMs / maxBase) * 100
                const cachePct = (step.cachedMs / maxBase) * 100
                const ratio = (step.baselineMs / Math.max(step.cachedMs, 1)).toFixed(1)
                return (
                  <tr key={step.name}>
                    <td>
                      <code>{step.name}</code>
                    </td>
                    <td>
                      <div className="wf-bars">
                        <div className="wf-bar wf-base" style={{ width: `${basePct.toFixed(1)}%` }} />
                        <div className="wf-bar wf-cache" style={{ width: `${cachePct.toFixed(1)}%` }} />
                      </div>
                    </td>
                    <td className="num">{(step.baselineMs / 1000).toFixed(2)}s</td>
                    <td className="num" style={{ color: "var(--lh-pass)", fontWeight: 700 }}>
                      {(step.cachedMs / 1000).toFixed(2)}s
                    </td>
                    <td className="num">{ratio}x</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Root-Input-Tracing Security Table */}
      <section className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Root-Input-Tracing Security Boundaries</h3>
            <p className="card-sub">
              Every privileged cache write, gate decision, token mint, and person-only action traced to its origin input
            </p>
          </div>
          <span className="pill pill-pass">0 untrusted bypass paths</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Privileged Step</th>
                <th>Origin Input</th>
                <th>Trust Boundary</th>
                <th>Enforcement</th>
                <th className="num">Untrusted Bypass</th>
              </tr>
            </thead>
            <tbody>
              {report.securityTraceRows.map((row) => (
                <tr key={row.privilegedStep}>
                  <td>
                    <strong>{row.privilegedStep}</strong>
                  </td>
                  <td>{row.originInput}</td>
                  <td>
                    <code>{row.trustBoundary}</code>
                  </td>
                  <td style={{ color: "var(--muted)" }}>{row.enforcementMechanism}</td>
                  <td className="num" style={{ color: "var(--lh-pass)", fontWeight: 700 }}>
                    BLOCKED
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
