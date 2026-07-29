import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { getFormation, mirror } from '../../lib/formations'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRING_SOFT } from '../../theme/motion'
// The chips here are the same two teams the board paints, so they take the same
// two values. This file used to keep its own lowercase copy of the pair, which
// is a third spelling of a colour that may only have one.
import { HOME_COLOR, AWAY_COLOR } from '../../theme/teamColors'

const L = 105
const W = 68

/**
 * A marking's slot in the draw-on queue and the length of its own outline, fed
 * to the `.mini-line` rule in index.css. Rect lengths ignore the 0.8 corner
 * radius, which is a fraction of a unit at this size.
 */
const draw = (i: number, len: number) =>
  ({ '--i': `${i}`, '--len': `${len}` }) as React.CSSProperties

const HOME_CYCLE = ['4-3-3', '4-2-3-1', '4-4-2', '3-4-3']
const AWAY_CYCLE = ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1']

const toXY = (p: { x: number; y: number; n: number }) => ({
  x: (p.x / 100) * L,
  y: (p.y / 100) * W,
  n: p.n,
})

function Chip({ x, y, n, color, keeper }: { x: number; y: number; n: number; color: string; keeper: boolean }) {
  return (
    <motion.g initial={false} animate={{ x, y }} transition={SPRING_SOFT}>
      <circle r={2.5} fill={color} stroke="rgba(255,255,255,0.55)" strokeWidth={0.4} />
      {keeper && <circle r={1.6} fill="none" stroke="#fbf9f5" strokeWidth={0.35} opacity={0.8} />}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={2.7}
        fontFamily="IBM Plex Mono, monospace"
        fontWeight={500}
        fill="#fbf9f5"
      >
        {n}
      </text>
    </motion.g>
  )
}

export default function MiniPitch({
  className = '',
  onCycle,
}: {
  className?: string
  /** Fires with the current home/away formation codes as they cycle. */
  onCycle?: (codes: { home: string; away: string }) => void
}) {
  const reduced = useReducedMotion()
  const [idx, setIdx] = useState(0)

  // Cycle formations. The markings draw themselves in from CSS, so the only
  // thing left to schedule here is which shape the chips are heading for.
  useEffect(() => {
    if (reduced) return
    const t = window.setInterval(() => setIdx((i) => i + 1), 3600)
    return () => window.clearInterval(t)
  }, [reduced])

  const homeCode = HOME_CYCLE[idx % HOME_CYCLE.length]
  const awayCode = AWAY_CYCLE[idx % AWAY_CYCLE.length]
  const home = getFormation(homeCode, '11').map(toXY)
  const away = mirror(getFormation(awayCode, '11')).map(toXY)

  useEffect(() => {
    onCycle?.({ home: homeCode, away: awayCode })
  }, [homeCode, awayCode, onCycle])

  const stroke = { className: 'mini-line', stroke: 'rgba(244,248,243,0.85)', strokeWidth: 0.35, fill: 'none' } as const

  return (
    <svg
      viewBox={`-2 -2 ${L + 4} ${W + 4}`}
      className={className}
      role="img"
      aria-label="Animated tactics board cycling through formations"
    >
      <defs>
        <clipPath id="mini-clip">
          <rect x={0} y={0} width={L} height={W} rx={0.8} />
        </clipPath>
      </defs>

      {/* Turf: the stripes cover it edge to edge, so there is no base beneath. */}
      <g clipPath="url(#mini-clip)">
        {Array.from({ length: 8 }).map((_, i) => (
          <rect
            key={i}
            x={(L / 8) * i}
            y={0}
            width={L / 8}
            height={W}
            fill={i % 2 === 0 ? '#2f4a3b' : '#34513f'}
          />
        ))}
      </g>

      {/* Markings, drawn in on mount by the `.mini-line` rule in index.css */}
      <rect x={0} y={0} width={L} height={W} rx={0.8} {...stroke} style={draw(0, 2 * (L + W))} />
      <line x1={L / 2} y1={0} x2={L / 2} y2={W} {...stroke} style={draw(1, W)} />
      <circle cx={L / 2} cy={W / 2} r={9.15} {...stroke} style={draw(2, 2 * Math.PI * 9.15)} />
      <rect
        x={0}
        y={W / 2 - 20.16}
        width={16.5}
        height={40.32}
        {...stroke}
        style={draw(3, 2 * (16.5 + 40.32))}
      />
      <rect
        x={L - 16.5}
        y={W / 2 - 20.16}
        width={16.5}
        height={40.32}
        {...stroke}
        style={draw(4, 2 * (16.5 + 40.32))}
      />
      <rect
        x={0}
        y={W / 2 - 9.16}
        width={5.5}
        height={18.32}
        {...stroke}
        style={draw(5, 2 * (5.5 + 18.32))}
      />
      <rect
        x={L - 5.5}
        y={W / 2 - 9.16}
        width={5.5}
        height={18.32}
        {...stroke}
        style={draw(6, 2 * (5.5 + 18.32))}
      />

      {/* Chips */}
      {home.map((p, i) => (
        <Chip key={`h${i}`} x={p.x} y={p.y} n={p.n} color={HOME_COLOR} keeper={p.n === 1} />
      ))}
      {away.map((p, i) => (
        <Chip key={`a${i}`} x={p.x} y={p.y} n={p.n} color={AWAY_COLOR} keeper={p.n === 1} />
      ))}
    </svg>
  )
}
