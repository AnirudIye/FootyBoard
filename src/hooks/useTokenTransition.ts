import { useEffect, useRef, useState } from 'react'
import type { Token } from '../lib/types'
import { useReducedMotion } from './useReducedMotion'

export interface Pt {
  x: number
  y: number
}

const DURATION = 420
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Returns the positions tokens should be drawn at. Normally that is simply
 * where the store says they are, so dragging tracks the pointer exactly. When
 * `epoch` changes (a formation applied, or an undo), chips glide from where
 * they were to their new positions instead of teleporting, because seeing the
 * movement is itself informative.
 */
export function useTokenTransition(tokens: Token[], epoch: number): Record<string, Pt> {
  const reduced = useReducedMotion()
  const [, force] = useState(0)

  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const displayRef = useRef<Record<string, Pt>>({})
  const fromRef = useRef<Record<string, Pt>>({})
  const startRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const animatingRef = useRef(false)

  // While idle the display follows the store exactly.
  if (!animatingRef.current) {
    const next: Record<string, Pt> = {}
    for (const t of tokens) next[t.id] = { x: t.x, y: t.y }
    displayRef.current = next
  }

  useEffect(() => {
    if (epoch === 0) return
    if (reduced) return

    fromRef.current = { ...displayRef.current }
    startRef.current = performance.now()
    animatingRef.current = true

    const tick = () => {
      const raw = Math.min(1, (performance.now() - startRef.current) / DURATION)
      const t = easeOut(raw)
      const next: Record<string, Pt> = {}
      for (const tok of tokensRef.current) {
        const from = fromRef.current[tok.id] ?? { x: tok.x, y: tok.y }
        next[tok.id] = {
          x: from.x + (tok.x - from.x) * t,
          y: from.y + (tok.y - from.y) * t,
        }
      }
      displayRef.current = next
      force((n) => n + 1)
      if (raw < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        animatingRef.current = false
        rafRef.current = null
      }
    }

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
        animatingRef.current = false
      }
    }
  }, [epoch, reduced])

  return displayRef.current
}
