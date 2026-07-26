import { useEffect, useRef } from 'react'
import { animate, stagger } from 'animejs'
import { useReducedMotion } from '../../hooks/useReducedMotion'

const CODES = ['4-3-3', '4-2-3-1', '3-5-2', '4-4-2', '5-3-2', '4-1-4-1', '3-4-3', '4-3-2-1']

const SPOTS = [
  { left: '8%', top: '18%', size: 46 },
  { left: '72%', top: '12%', size: 34 },
  { left: '84%', top: '54%', size: 54 },
  { left: '14%', top: '68%', size: 40 },
  { left: '46%', top: '8%', size: 30 },
  { left: '60%', top: '74%', size: 44 },
  { left: '28%', top: '40%', size: 28 },
  { left: '90%', top: '30%', size: 30 },
]

/** Faint tactical notation drifting behind the hero. anime.js, on a loop. */
export default function NotationDrift() {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const el = ref.current
    if (!el || reduced) return
    const items = el.querySelectorAll('.drift')
    const anim = animate(items, {
      translateY: [
        { to: -14, duration: 4200 },
        { to: 0, duration: 4200 },
      ],
      opacity: [
        { to: 0.14, duration: 1200 },
        { to: 0.06, duration: 3400 },
      ],
      loop: true,
      alternate: true,
      delay: stagger(320),
      ease: 'inOutSine',
    })
    return () => {
      anim.pause()
    }
  }, [reduced])

  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {SPOTS.map((s, i) => (
        <span
          key={i}
          className="drift absolute font-mono tabular-nums text-ink"
          style={{ left: s.left, top: s.top, fontSize: s.size, opacity: reduced ? 0.06 : 0 }}
        >
          {CODES[i % CODES.length]}
        </span>
      ))}
    </div>
  )
}
