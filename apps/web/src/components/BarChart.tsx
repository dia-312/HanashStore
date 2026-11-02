import { formatMoney } from '../lib/money'

// A bar chart in plain SVG (no chart library, SPEC section 17). Time runs right to left like the
// rest of the page. Each bar has its value in a tooltip title and the page always has the same
// numbers in a table next to it, so the chart is never the only way to read them.

export interface Bar {
  label: string
  value: number
}

const W = 720
const H = 220
const TOP = 16
const BOTTOM = 34
const GAP = 4

export function BarChart({ bars, caption }: { bars: Bar[]; caption: string }) {
  if (bars.length === 0) return null
  const max = Math.max(0, ...bars.map((b) => b.value))
  const min = Math.min(0, ...bars.map((b) => b.value))
  const span = max - min || 1
  const plot = H - TOP - BOTTOM
  const zero = TOP + (plot * max) / span // the y of the value 0
  const slot = W / bars.length
  const width = Math.max(1, slot - GAP)
  // a label every few bars so they never run into each other
  const every = Math.max(1, Math.ceil(bars.length / 10))

  return (
    <figure className="grid gap-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={caption}
        className="w-full max-w-3xl rounded-xl bg-white"
        preserveAspectRatio="xMidYMid meet"
      >
        <line x1="0" x2={W} y1={zero} y2={zero} stroke="currentColor" strokeOpacity="0.4" />
        {bars.map((bar, i) => {
          const h = (Math.abs(bar.value) / span) * plot
          // right to left: the first bar is the rightmost
          const x = W - (i + 1) * slot + GAP / 2
          const y = bar.value >= 0 ? zero - h : zero
          return (
            <g key={`${bar.label}-${i}`}>
              <title>{`${bar.label}: ${formatMoney(bar.value)}`}</title>
              <rect
                x={x}
                y={y}
                width={width}
                height={Math.max(bar.value === 0 ? 0 : 1, h)}
                rx="2"
                fill="currentColor"
                fillOpacity={bar.value < 0 ? 0.35 : 0.85}
                stroke={bar.value < 0 ? 'currentColor' : 'none'}
                strokeDasharray={bar.value < 0 ? '3 2' : undefined}
              />
              {i % every === 0 && (
                <text
                  x={x + width / 2}
                  y={H - 12}
                  textAnchor="middle"
                  fontSize="11"
                  fill="currentColor"
                >
                  {bar.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <figcaption className="text-sm opacity-80">{caption}</figcaption>
    </figure>
  )
}
