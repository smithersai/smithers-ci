import type { AuditCategorySummary, AuditCheck, BackpressureAuditReport } from "./AuditEngine.ts"

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch)
}

function gaugeColor(score: number): string {
  if (score >= 90) return "var(--lh-pass)"
  if (score >= 50) return "var(--lh-avg)"
  return "var(--lh-fail)"
}

function renderGauge(label: string, score: number, size = 96): string {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  const offset = circumference * (1 - clamped / 100)
  const color = gaugeColor(clamped)

  return `
  <div class="lh-gauge" style="--gauge-color:${color}">
    <svg viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(label)} score ${clamped} out of 100">
      <circle class="lh-gauge-base" cx="50" cy="50" r="${radius}" />
      <circle class="lh-gauge-arc" cx="50" cy="50" r="${radius}"
        stroke-dasharray="${circumference.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}" />
      <text class="lh-gauge-num" x="50" y="55" text-anchor="middle">${clamped}</text>
    </svg>
    <div class="lh-gauge-label">${escapeHtml(label)}</div>
  </div>`
}

function renderAuditRow(audit: AuditCheck): string {
  const badgeClass =
    audit.status === "pass" ? "dot-pass" : audit.status === "warn" ? "dot-warn" : "dot-fail"
  const evidenceItems = audit.evidence
    .map((line) => `<li><code>${escapeHtml(line)}</code></li>`)
    .join("")
  const remediation = audit.remediation
    ? `<p class="remediation">Action: ${escapeHtml(audit.remediation)}</p>`
    : ""

  return `
  <details class="audit-row" ${audit.status !== "pass" ? "open" : ""}>
    <summary>
      <span class="dot ${badgeClass}" aria-hidden="true"></span>
      <span class="audit-title">${escapeHtml(audit.title)}</span>
      <span class="audit-value">${escapeHtml(audit.displayValue)}</span>
      <span class="audit-score">${audit.score}</span>
    </summary>
    <div class="audit-body">
      <p>${escapeHtml(audit.description)}</p>
      <ul class="evidence-list">${evidenceItems}</ul>
      ${remediation}
      <div class="audit-meta">ID: <code>${escapeHtml(audit.id)}</code> · Weight: ${audit.weight} · ${audit.durationMs}ms</div>
    </div>
  </details>`
}

function renderCategorySection(cat: AuditCategorySummary): string {
  const rows = cat.audits.map(renderAuditRow).join("\n")
  return `
  <section class="category-card cat-section" data-cat="${escapeHtml(cat.id)}" id="cat-${escapeHtml(cat.id)}">
    <header class="category-head">
      <div class="category-title-wrap">
        ${renderGauge(cat.shortTitle, cat.score, 64)}
        <div>
          <h2>${escapeHtml(cat.title)}</h2>
          <p class="muted">${cat.passedCount} passed · ${cat.warnCount} warnings · ${cat.failCount} failed</p>
        </div>
      </div>
    </header>
    <div class="audit-list">
      ${rows}
    </div>
  </section>`
}

/**
 * Renders a self-contained, zero-JS, CSP-locked (`default-src 'none'`),
 * Lighthouse-inspired HTML backpressure audit report with pure-CSS interactive
 * category filter tabs, dark/light theme switcher, and print styles.
 */
export function renderLighthouseHtml(report: BackpressureAuditReport): string {
  const shortSha = /^[0-9a-f]{40}$/i.test(report.commitSha) ? report.commitSha.slice(0, 12) : report.commitSha
  const trusted = report.execution.trusted
  const isExample = report.isExample === true
  const bannerClass = isExample ? "banner-untrusted" : trusted ? "banner-trusted" : "banner-untrusted"
  const bannerHeadline = isExample
    ? `EXAMPLE REPORT (${report.policy.provenanceBadge}): Illustrative example fixture, not live checkout verification`
    : trusted
      ? `${report.policy.provenanceBadge}: Externally verified execution eligible for shared cache writes and release gates`
      : `${report.policy.provenanceBadge}: Local or community audit run, isolated from shared cache writes and merge gates`

  const topGauges = report.categories
    .map(
      (cat) => `
      <label class="gauge-link" for="filter-${escapeHtml(cat.id)}" title="Filter to ${escapeHtml(cat.title)}">
        ${renderGauge(cat.shortTitle, cat.score, 96)}
      </label>`
    )
    .join("\n")

  const categorySections = report.categories.map(renderCategorySection).join("\n")

  const filterRadios = [
    `<input class="sr-radio" type="radio" name="lh-cat" id="filter-all" checked>`,
    ...report.categories.map(
      (cat) => `<input class="sr-radio" type="radio" name="lh-cat" id="filter-${escapeHtml(cat.id)}">`
    )
  ].join("\n  ")

  const filterLabels = [
    `<label class="filter-pill" for="filter-all">All (${report.summary.totalAudits})</label>`,
    ...report.categories.map(
      (cat) =>
        `<label class="filter-pill" for="filter-${escapeHtml(cat.id)}">${escapeHtml(cat.shortTitle)} (${cat.score})</label>`
    )
  ].join("\n      ")

  const filterCssRules = report.categories
    .map(
      (cat) =>
        `#filter-${escapeHtml(cat.id)}:checked ~ .report-shell .cat-section:not([data-cat="${escapeHtml(cat.id)}"]) { display: none; }\n` +
        `#filter-${escapeHtml(cat.id)}:checked ~ .report-shell label[for="filter-${escapeHtml(cat.id)}"] { background: var(--accent); color: #04150f; border-color: transparent; }`
    )
    .join("\n")

  const maxBaseline = Math.max(...report.waterfall.map((s) => s.baselineMs), 1)
  const waterfallRows = report.waterfall.length === 0
    ? `
      <tr>
        <td colspan="5" class="muted">No timing waterfall measurements were recorded for this audit run.</td>
      </tr>`
    : report.waterfall
    .map((step) => {
      const basePct = ((step.baselineMs / maxBaseline) * 100).toFixed(1)
      const cachePct = ((step.cachedMs / maxBaseline) * 100).toFixed(1)
      const ratio = step.cachedMs > 0 ? (step.baselineMs / step.cachedMs).toFixed(1) : "1.0"
      return `
      <tr>
        <td><code>${escapeHtml(step.name)}</code></td>
        <td>
          <div class="wf-track">
            <div class="wf-bar wf-base" style="width:${basePct}%"></div>
            <div class="wf-bar wf-cache" style="width:${cachePct}%"></div>
          </div>
        </td>
        <td class="num">${(step.baselineMs / 1000).toFixed(2)}s</td>
        <td class="num ok">${(step.cachedMs / 1000).toFixed(2)}s</td>
        <td class="num">${ratio}x</td>
      </tr>`
    })
    .join("\n")

  const traceRows = report.securityTraceRows
    .map(
      (row) => `
      <tr>
        <td><strong>${escapeHtml(row.privilegedStep)}</strong></td>
        <td>${escapeHtml(row.originInput)}</td>
        <td><code>${escapeHtml(row.trustBoundary)}</code></td>
        <td>${escapeHtml(row.enforcementMechanism)}</td>
        <td class="num ok">Blocked</td>
      </tr>`
    )
    .join("\n")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Smithers CI Backpressure Audit · ${escapeHtml(report.repository)} @ ${escapeHtml(shortSha)}</title>
<style>
:root {
  --bg: #0b100e;
  --surface: #121917;
  --surface-2: #18221f;
  --text: #eef5f2;
  --muted: #93a79f;
  --line: #23312c;
  --lh-pass: #0cce6b;
  --lh-avg: #ffa400;
  --lh-fail: #ff4e42;
  --accent: #4fd1b1;
  --base-bar: #475569;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
#lh-light-mode:checked ~ .page-bg {
  --bg: #f8faf9;
  --surface: #ffffff;
  --surface-2: #f1f5f3;
  --text: #0f1715;
  --muted: #4b5c56;
  --line: #dce4e0;
  --lh-pass: #0c9f59;
  --lh-avg: #d97706;
  --lh-fail: #dc2626;
  --accent: #0b6e5b;
  --base-bar: #94a3b8;
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.55 var(--sans); }
.page-bg { min-height: 100vh; background: var(--bg); color: var(--text); transition: background 160ms ease, color 160ms ease; }
main { max-width: 1080px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.sr-radio { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }
.topbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem; }
.topbar h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.02em; }
.topbar-right { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
.meta { font-family: var(--mono); font-size: 0.82rem; color: var(--muted); }
.theme-toggle { cursor: pointer; font-size: 0.8rem; font-weight: 600; padding: 0.3rem 0.7rem; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--text); user-select: none; }
.theme-toggle:hover { border-color: var(--accent); }
.banner { padding: 0.9rem 1.1rem; border-radius: 10px; border: 1px solid var(--line); margin-bottom: 1.5rem; font-weight: 500; }
.banner-trusted { background: color-mix(in srgb, var(--lh-pass) 12%, var(--surface)); border-color: color-mix(in srgb, var(--lh-pass) 40%, var(--line)); }
.banner-untrusted { background: color-mix(in srgb, var(--lh-avg) 14%, var(--surface)); border-color: color-mix(in srgb, var(--lh-avg) 45%, var(--line)); }
.banner-sub { display: block; margin-top: 0.25rem; font-size: 0.86rem; font-weight: 400; color: var(--muted); }
.hero-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 1.75rem 1.25rem; margin-bottom: 1.25rem; }
.hero-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1.5rem; border-bottom: 1px solid var(--line); padding-bottom: 1.4rem; margin-bottom: 1.4rem; }
.overall-wrap { display: flex; align-items: center; gap: 1.25rem; }
.legend { display: flex; gap: 1.1rem; font-size: 0.82rem; color: var(--muted); flex-wrap: wrap; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 999px; margin-right: 6px; vertical-align: middle; }
.leg-pass::before { background: var(--lh-pass); }
.leg-avg::before { background: var(--lh-avg); }
.leg-fail::before { background: var(--lh-fail); }
.gauge-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 1rem; text-align: center; }
.gauge-link { cursor: pointer; display: block; padding: 0.45rem; border-radius: 10px; transition: background 140ms ease; }
.gauge-link:hover { background: var(--surface-2); }
.lh-gauge { display: flex; flex-direction: column; align-items: center; gap: 0.45rem; }
.lh-gauge-base { fill: color-mix(in srgb, var(--gauge-color) 11%, transparent); stroke: color-mix(in srgb, var(--gauge-color) 25%, var(--line)); stroke-width: 7; }
.lh-gauge-arc { fill: none; stroke: var(--gauge-color); stroke-width: 7; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; }
.lh-gauge-num { fill: var(--gauge-color); font: 700 26px var(--mono); }
.lh-gauge-label { font-size: 0.86rem; font-weight: 600; color: var(--text); }
.filter-bar { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-bottom: 1.25rem; }
.filter-pill { cursor: pointer; font-family: var(--mono); font-size: 0.78rem; font-weight: 600; padding: 0.35rem 0.75rem; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); user-select: none; transition: background 120ms ease, color 120ms ease; }
.filter-pill:hover { color: var(--text); border-color: var(--accent); }
#filter-all:checked ~ .report-shell label[for="filter-all"] { background: var(--accent); color: #04150f; border-color: transparent; }
${filterCssRules}
.category-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem; }
.category-head { margin-bottom: 0.85rem; }
.category-title-wrap { display: flex; align-items: center; gap: 1rem; }
.category-title-wrap h2 { margin: 0; font-size: 1.12rem; }
.muted { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.86rem; }
.audit-row { border-top: 1px solid var(--line); padding: 0.65rem 0; }
.audit-row summary { cursor: pointer; display: grid; grid-template-columns: 14px 1fr auto 40px; gap: 0.7rem; align-items: center; list-style: none; font-weight: 500; }
.audit-row summary::-webkit-details-marker { display: none; }
.dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
.dot-pass { background: var(--lh-pass); }
.dot-warn { background: var(--lh-avg); }
.dot-fail { background: var(--lh-fail); }
.audit-value { font-family: var(--mono); font-size: 0.82rem; color: var(--muted); }
.audit-score { font-family: var(--mono); font-size: 0.85rem; font-weight: 700; text-align: right; }
.audit-body { padding: 0.6rem 0 0.25rem 1.65rem; font-size: 0.9rem; color: var(--muted); }
.audit-body p { margin: 0 0 0.5rem; }
.evidence-list { margin: 0; padding-left: 1.1rem; }
.evidence-list li { margin: 0.2rem 0; }
.audit-meta { margin-top: 0.5rem; font-size: 0.78rem; color: var(--muted); }
.remediation { color: var(--lh-avg); font-weight: 500; }
code { font-family: var(--mono); font-size: 0.84em; background: var(--surface-2); padding: 0.1rem 0.35rem; border-radius: 4px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
th, td { padding: 0.55rem 0.65rem; border-bottom: 1px solid var(--line); text-align: left; }
th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.num { font-family: var(--mono); text-align: right; white-space: nowrap; }
.ok { color: var(--lh-pass); font-weight: 600; }
.wf-track { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.wf-bar { height: 7px; border-radius: 999px; }
.wf-base { background: var(--base-bar); }
.wf-cache { background: var(--lh-pass); }
@media print {
  .theme-toggle, .filter-bar { display: none; }
  .page-bg { background: #ffffff; color: #0f1715; }
  .category-card, .hero-panel { break-inside: avoid; border-color: #cbd5e1; }
}
</style>
</head>
<body>
<input class="sr-radio" type="checkbox" id="lh-light-mode">
<div class="page-bg">
<main>
  ${filterRadios}
  <div class="report-shell">
    <div class="topbar">
      <h1>Smithers CI Backpressure Audit Report</h1>
      <div class="topbar-right">
        <div class="meta">${escapeHtml(report.repository)} @ ${escapeHtml(shortSha)} · ${escapeHtml(report.generatedAt)}</div>
        <label class="theme-toggle" for="lh-light-mode">Toggle Light / Dark</label>
      </div>
    </div>

    <div class="banner ${bannerClass}">
      ${escapeHtml(bannerHeadline)}
      <span class="banner-sub">Actor: ${escapeHtml(report.execution.actor)} · Gate status: ${escapeHtml(report.gate.status)} · ${escapeHtml(report.gate.reason)}</span>
    </div>

    <section class="hero-panel">
      <div class="hero-top">
        <div class="overall-wrap">
          ${renderGauge("Overall", report.overallScore, 112)}
          <div>
            <h2 style="margin:0 0 0.25rem;font-size:1.25rem;">Backpressure Health Score</h2>
            <p class="muted">${report.summary.passed}/${report.summary.totalAudits} audits passed · ${report.summary.warnings} warnings · ${report.summary.failed} failed</p>
            <p class="muted">Release threshold: ${report.summary.releaseThreshold}/100 · Release gate: <strong>${report.summary.releaseReady ? "SATISFIED" : "NOT SATISFIED"}</strong> · CSP: <code>script-src 'none'</code></p>
          </div>
        </div>
        <div class="legend">
          <span class="leg-pass">90-100 Pass</span>
          <span class="leg-avg">50-89 Needs Work</span>
          <span class="leg-fail">0-49 Fail</span>
        </div>
      </div>
      <div class="gauge-grid">
        ${topGauges}
      </div>
    </section>

    <div class="filter-bar" role="tablist" aria-label="Filter backpressure audit categories">
      ${filterLabels}
    </div>

    ${categorySections}

    <section class="category-card">
      <header class="category-head">
        <h2 style="margin:0;">Cache &amp; Replay Timing Waterfall</h2>
        <p class="muted">Baseline cold execution vs shared Smithers Cloud object store (build.smithers.sh)</p>
      </header>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Baseline vs Cached</th>
              <th class="num">Baseline</th>
              <th class="num">Cached</th>
              <th class="num">Speedup</th>
            </tr>
          </thead>
          <tbody>
            ${waterfallRows}
          </tbody>
        </table>
      </div>
    </section>

    <section class="category-card">
      <header class="category-head">
        <h2 style="margin:0;">Root-Input-Tracing Security Boundaries</h2>
        <p class="muted">Every privileged operation verified back to its origin input</p>
      </header>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Privileged Step</th>
              <th>Origin Input</th>
              <th>Trust Boundary</th>
              <th>Enforcement</th>
              <th class="num">Untrusted Bypass</th>
            </tr>
          </thead>
          <tbody>
            ${traceRows}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</main>
</div>
</body>
</html>`
}
