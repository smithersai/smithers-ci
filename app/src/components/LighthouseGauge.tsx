import React from "react"

export function gaugeColorForScore(score: number): string {
  if (score >= 90) return "var(--lh-pass)"
  if (score >= 50) return "var(--lh-avg)"
  return "var(--lh-fail)"
}

export function LighthouseGauge({
  label,
  score,
  size = 98,
  sublabel
}: {
  readonly label: string
  readonly score: number
  readonly size?: number
  readonly sublabel?: string
}) {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  const offset = circumference * (1 - clamped / 100)
  const color = gaugeColorForScore(clamped)

  return (
    <div className="lh-gauge" style={{ ["--gauge-color" as string]: color }}>
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={`${label} score ${clamped} out of 100`}
      >
        <circle className="lh-gauge-base" cx="50" cy="50" r={radius} />
        <circle
          className="lh-gauge-arc"
          cx="50"
          cy="50"
          r={radius}
          strokeDasharray={circumference.toFixed(2)}
          strokeDashoffset={offset.toFixed(2)}
        />
        <text className="lh-gauge-num" x="50" y="55" textAnchor="middle">
          {clamped}
        </text>
      </svg>
      <div className="lh-gauge-label">{label}</div>
      {sublabel ? <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{sublabel}</div> : null}
    </div>
  )
}
