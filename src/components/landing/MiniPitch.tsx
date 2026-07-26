import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { animate, svg, stagger } from 'animejs'
import { getFormation, mirror } from '../../lib/formations'
import { useReducedMotion } from '../../hooks/useReducedMotion'

const L = 105
const W = 68
const HOME = '#b4432e'
const AWAY = '#2c5b8a'

const HOME_CYCLE = ['4-3-3', '4-2-3-1', '4-4-2', '3-4-3']
const AWAY_CYCLE = ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1']

const toXY = (p: { x: number; y: number; n: number }) => ({
  x: (p.x / 100) * L,
  y: (p.y / 100) * W,
  n: p.n,
})

function Chip({ x, y, n, color, keeper }: { x: number; y: number; n: number; color: string; keeper: boolean }) {
  return (
    <motion.g
      initial={false}
      animate={{ x, y }}
      transition={{ type: 'spring', stiffness: 120, damping: 18, mass: 0.7 }}
    >
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
  const ref = useRef<SVGSVGElement>(null)
  const [idx, setIdx] = useState(0)

  // Draw the pitch lines in on mount.
  useEffect(() => {
    const el = ref.current
    if (!el || reduced) return
    const lines = Array.from(el.querySelectorAll<SVGElement>('.mini-line'))
    const drawables = svg.createDrawable(lines)
    const anim = animate(drawables, {
      draw: ['0 0', '0 1'],
      duration: 1100,
      delay: stagger(70),
      ease: 'inOutQuad',
    })
    return () => {
      anim.pause()
    }
  }, [reduced])

  // Cycle formations.
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
      ref={ref}
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

      {/* Turf with mow stripes */}
      <g clipPath="url(#mini-clip)">
        <rect x={0} y={0} width={L} height={W} fill="#2f4a3b" />
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

      {/* Markings (self-drawing) */}
      <rect x={0} y={0} width={L} height={W} rx={0.8} {...stroke} />
      <line x1={L / 2} y1={0} x2={L / 2} y2={W} {...stroke} />
      <circle cx={L / 2} cy={W / 2} r={9.15} {...stroke} />
      <rect x={0} y={W / 2 - 20.16} width={16.5} height={40.32} {...stroke} />
      <rect x={L - 16.5} y={W / 2 - 20.16} width={16.5} height={40.32} {...stroke} />
      <rect x={0} y={W / 2 - 9.16} width={5.5} height={18.32} {...stroke} />
      <rect x={L - 5.5} y={W / 2 - 9.16} width={5.5} height={18.32} {...stroke} />

      {/* Chips */}
      {home.map((p, i) => (
        <Chip key={`h${i}`} x={p.x} y={p.y} n={p.n} color={HOME} keeper={p.n === 1} />
      ))}
      {away.map((p, i) => (
        <Chip key={`a${i}`} x={p.x} y={p.y} n={p.n} color={AWAY} keeper={p.n === 1} />
      ))}
    </svg>
  )
}
