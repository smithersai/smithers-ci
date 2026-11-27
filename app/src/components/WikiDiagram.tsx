import React from "react"

interface DiagramNode {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly label: string
  readonly sub?: string
  readonly tone?: "accent" | "pass" | "warn" | "info" | "neutral"
}

interface DiagramEdge {
  readonly from: [number, number]
  readonly to: [number, number]
  readonly label?: string
}

interface DiagramSpec {
  readonly viewBox: string
  readonly title: string
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly edges: ReadonlyArray<DiagramEdge>
}

const DIAGRAMS: Readonly<Record<string, DiagramSpec>> = {
  index: {
    viewBox: "0 0 760 190",
    title: "Smithers CI End-to-End Architecture",
    nodes: [
      { x: 14, y: 24, w: 128, h: 58, label: "Repository", sub: "Git / jj + CI YAML", tone: "neutral" },
      { x: 174, y: 24, w: 142, h: 58, label: "smthrs-observe", sub: "seccomp + bwrap", tone: "info" },
      { x: 348, y: 24, w: 162, h: 58, label: "Shared Object Store", sub: "build.smithers.sh", tone: "pass" },
      { x: 542, y: 24, w: 198, h: 58, label: "Lighthouse Audit", sub: "6 Categories (0-100)", tone: "accent" },
      { x: 174, y: 116, w: 185, h: 56, label: "Authenticated Cloud MCP", sub: "20 tools · smo_ auth", tone: "info" },
      { x: 382, y: 116, w: 184, h: 56, label: "Personalized Factory UI", sub: "Maintainer · Contrib · View", tone: "accent" },
      { x: 590, y: 116, w: 150, h: 56, label: "GitHub Mirror", sub: "Auto Docs & Release", tone: "pass" }
    ],
    edges: [
      { from: [142, 53], to: [172, 53] },
      { from: [316, 53], to: [346, 53] },
      { from: [510, 53], to: [540, 53] },
      { from: [428, 82], to: [428, 114] },
      { from: [359, 144], to: [380, 144] },
      { from: [566, 144], to: [588, 144] }
    ]
  },
  "kernel-observer": {
    viewBox: "0 0 760 175",
    title: "Linux seccomp-unotify Kernel Observation Flow",
    nodes: [
      { x: 18, y: 30, w: 165, h: 66, label: "Bubblewrap Jail", sub: "Unprivileged mount/net ns", tone: "warn" },
      { x: 218, y: 30, w: 168, h: 66, label: "CI Step Process", sub: "openat / statx / execve", tone: "neutral" },
      { x: 420, y: 30, w: 160, h: 66, label: "smthrs-observe", sub: "Record format /7", tone: "info" },
      { x: 610, y: 30, w: 134, h: 66, label: "CAS Key", sub: "0 stale passes", tone: "pass" }
    ],
    edges: [
      { from: [183, 63], to: [216, 63], label: "confines" },
      { from: [386, 63], to: [418, 63], label: "seccomp" },
      { from: [580, 63], to: [608, 63], label: "SHA-256" }
    ]
  },
  "incremental-replay": {
    viewBox: "0 0 760 155",
    title: "Four-Stage Incremental Replay Pipeline",
    nodes: [
      { x: 14, y: 40, w: 130, h: 62, label: "1. Inventory", sub: ".github/workflows", tone: "neutral" },
      { x: 168, y: 40, w: 130, h: 62, label: "2. Decompose", sub: "Split workspace steps", tone: "info" },
      { x: 322, y: 40, w: 130, h: 62, label: "3. Generate", sub: "WORKSPACE.smithers", tone: "info" },
      { x: 476, y: 40, w: 124, h: 62, label: "4. Replay", sub: "Cold vs Warm", tone: "accent" },
      { x: 624, y: 40, w: 122, h: 62, label: "5. Verify", sub: "0 mismatches", tone: "pass" }
    ],
    edges: [
      { from: [144, 71], to: [166, 71] },
      { from: [298, 71], to: [320, 71] },
      { from: [452, 71], to: [474, 71] },
      { from: [600, 71], to: [622, 71] }
    ]
  },
  "shared-object-store": {
    viewBox: "0 0 760 190",
    title: "Split-Credential Shared Object Store Architecture",
    nodes: [
      { x: 20, y: 20, w: 225, h: 60, label: "Trusted Sandbox / Maintainer", sub: "READ + WRITE (/ac, /cas, trusted/)", tone: "pass" },
      { x: 20, y: 108, w: 225, h: 60, label: "Untrusted Community Run", sub: "READ ONLY cache + untrusted/ area", tone: "warn" },
      { x: 315, y: 36, w: 205, h: 118, label: "build.smithers.sh", sub: "SHA-256 verified /ac & /cas", tone: "accent" },
      { x: 556, y: 36, w: 184, h: 52, label: "trusted/<sha>/*", sub: "Gate-eligible artifacts", tone: "pass" },
      { x: 556, y: 102, w: 184, h: 52, label: "untrusted/<actor>/*", sub: "Isolated community previews", tone: "warn" }
    ],
    edges: [
      { from: [245, 50], to: [313, 72], label: "R/W" },
      { from: [245, 138], to: [313, 122], label: "Read" },
      { from: [520, 62], to: [554, 62] },
      { from: [520, 128], to: [554, 128] }
    ]
  },
  "trust-and-isolation": {
    viewBox: "0 0 760 200",
    title: "Three-Tier Execution Trust Verification",
    nodes: [
      { x: 16, y: 68, w: 150, h: 64, label: "Execution Claim", sub: "Actor + SHA + HMAC", tone: "neutral" },
      { x: 206, y: 68, w: 170, h: 64, label: "verifyExecutionTrust", sub: "Constant-time HMAC", tone: "info" },
      { x: 430, y: 14, w: 312, h: 48, label: "trusted:maintainer (roninjin10)", sub: "Cache R/W + Gate Eligible", tone: "pass" },
      { x: 430, y: 76, w: 312, h: 48, label: "trusted:sandbox (cfbox / gate / nyc)", sub: "Cache R/W + Gate Eligible", tone: "pass" },
      { x: 430, y: 138, w: 312, h: 48, label: "untrusted:community (encouraged!)", sub: "Warm Cache Read ONLY + Preview Gate", tone: "warn" }
    ],
    edges: [
      { from: [166, 100], to: [204, 100] },
      { from: [376, 86], to: [428, 38] },
      { from: [376, 100], to: [428, 100] },
      { from: [376, 114], to: [428, 162] }
    ]
  },
  "lighthouse-backpressure": {
    viewBox: "0 0 780 185",
    title: "Six-Category Lighthouse Backpressure Rubric",
    nodes: [
      { x: 16, y: 20, w: 236, h: 50, label: "Correctness & Determinism", sub: "Typecheck · Tests · 0 Mismatches", tone: "pass" },
      { x: 272, y: 20, w: 236, h: 50, label: "Cache & Speed", sub: "build.smithers.sh · 4.4x Replay", tone: "pass" },
      { x: 528, y: 20, w: 236, h: 50, label: "Security & Trust Isolation", sub: "0 Poisoning · Single-Use Auth", tone: "pass" },
      { x: 16, y: 88, w: 236, h: 50, label: "Formal & Fuzz Assurance", sub: "387 Lean 4 · 40 Fuzz Suites", tone: "info" },
      { x: 272, y: 88, w: 236, h: 50, label: "Wiki & Docs Freshness", sub: "0 Broken Links · SVG Diagrams", tone: "info" },
      { x: 528, y: 88, w: 236, h: 50, label: "Release & Cloud Readiness", sub: "3 Audiences · Auto Mirror · MCP", tone: "accent" }
    ],
    edges: []
  },
  "mcp-and-one-time-auth": {
    viewBox: "0 0 760 175",
    title: "Single-Use Token Mint and PKCE S256 Exchange",
    nodes: [
      { x: 16, y: 42, w: 164, h: 70, label: "Control Plane", sub: "Mints smo_<64hex>", tone: "pass" },
      { x: 218, y: 42, w: 166, h: 70, label: "Sandbox / Agent", sub: "Mode-600 file + PKCE", tone: "info" },
      { x: 422, y: 42, w: 166, h: 70, label: "POST /mcp/exchange", sub: "Atomic SQLite burn", tone: "warn" },
      { x: 616, y: 42, w: 130, h: 70, label: "Cloud MCP", sub: "Bearer sms_ lease", tone: "accent" }
    ],
    edges: [
      { from: [180, 77], to: [216, 77], label: "1-time" },
      { from: [384, 77], to: [420, 77], label: "redeem" },
      { from: [588, 77], to: [614, 77], label: "lease" }
    ]
  },
  "release-and-mirror": {
    viewBox: "0 0 760 175",
    title: "Smithers Cloud to GitHub Mirror Auto-Release Pipeline",
    nodes: [
      { x: 16, y: 50, w: 150, h: 64, label: "Smithers Cloud", sub: "Person merges main", tone: "accent" },
      { x: 196, y: 50, w: 156, h: 64, label: "GitHub Mirror", sub: "push -> main / v*", tone: "neutral" },
      { x: 382, y: 50, w: 164, h: 64, label: "Trusted Audit Gate", sub: "Lighthouse >= 90", tone: "pass" },
      { x: 576, y: 18, w: 168, h: 52, label: "Cloudflare Deploy", sub: "UI + Wiki + MCP", tone: "info" },
      { x: 576, y: 92, w: 168, h: 52, label: "npm + GH Release", sub: "Provenance tarballs", tone: "pass" }
    ],
    edges: [
      { from: [166, 82], to: [194, 82] },
      { from: [352, 82], to: [380, 82] },
      { from: [546, 70], to: [574, 44] },
      { from: [546, 94], to: [574, 118] }
    ]
  },
  "formal-verification": {
    viewBox: "0 0 760 175",
    title: "Lean 4 Formal Verification and Fuzzing Funnel",
    nodes: [
      { x: 16, y: 40, w: 215, h: 74, label: "6 Lean 4.32 Packages", sub: "51 .lean files · 387 theorems · 0 sorry", tone: "pass" },
      { x: 270, y: 40, w: 215, h: 74, label: "Differential Fuzzing", sub: "55,685 queries + 40 fuzz suites", tone: "info" },
      { x: 524, y: 40, w: 220, h: 74, label: "Zero-Bypass Runtime", sub: "Trust + Token + CAS + XSS verified", tone: "accent" }
    ],
    edges: [
      { from: [231, 77], to: [268, 77], label: "oracle" },
      { from: [485, 77], to: [522, 77], label: "proves" }
    ]
  }
}

function strokeForTone(tone: DiagramNode["tone"]): string {
  switch (tone) {
    case "pass":
      return "var(--lh-pass)"
    case "warn":
      return "var(--lh-avg)"
    case "info":
      return "var(--info)"
    case "accent":
      return "var(--accent)"
    default:
      return "var(--line-strong)"
  }
}

export function WikiDiagram({ slug }: { readonly slug: string }) {
  const spec = DIAGRAMS[slug]
  if (!spec) return null

  return (
    <div className="wiki-diagram-card">
      <div className="wiki-diagram-caption">{spec.title}</div>
      <svg
        viewBox={spec.viewBox}
        role="img"
        aria-label={spec.title}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <defs>
          <marker
            id={`arrow-${slug}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--muted)" />
          </marker>
        </defs>

        {spec.edges.map((edge, idx) => {
          const midX = (edge.from[0] + edge.to[0]) / 2
          const midY = (edge.from[1] + edge.to[1]) / 2 - 6
          return (
            <g key={idx}>
              <line
                x1={edge.from[0]}
                y1={edge.from[1]}
                x2={edge.to[0]}
                y2={edge.to[1]}
                stroke="var(--muted)"
                strokeWidth="1.6"
                markerEnd={`url(#arrow-${slug})`}
              />
              {edge.label ? (
                <text
                  x={midX}
                  y={midY}
                  textAnchor="middle"
                  fill="var(--muted)"
                  fontSize="10"
                  fontFamily="var(--mono)"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          )
        })}

        {spec.nodes.map((node, idx) => {
          const stroke = strokeForTone(node.tone)
          return (
            <g key={idx}>
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx="10"
                fill="var(--surface-2)"
                stroke={stroke}
                strokeWidth="1.5"
              />
              <text
                x={node.x + node.w / 2}
                y={node.y + (node.sub ? node.h / 2 - 4 : node.h / 2 + 4)}
                textAnchor="middle"
                fill="var(--text)"
                fontSize="12"
                fontWeight="700"
                fontFamily="var(--sans)"
              >
                {node.label}
              </text>
              {node.sub ? (
                <text
                  x={node.x + node.w / 2}
                  y={node.y + node.h / 2 + 13}
                  textAnchor="middle"
                  fill="var(--muted)"
                  fontSize="10"
                  fontFamily="var(--mono)"
                >
                  {node.sub}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
