import { useEffect, useRef, useState } from 'react'
import { animate } from 'framer-motion'
import type { Token } from '../lib/types'
import { useReducedMotion } from './useReducedMotion'

export interface Pt {
  x: number
  y: number
}

const DURATION = 0.42 // seconds
// The same cubic ease-out the hand-rolled tween used, kept exactly, because
// this is the curve every chip on the board travels along.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Returns the positions tokens should be drawn at. Normally that is simply
 * where the store says they are, so dragging tracks the pointer exactly. When
 * `epoch` changes (a formation applied, or an undo), chips glide from where
 * they were to their new positions instead of teleporting, because seeing the
 * movement is itself informative.
 *
 * The glide runs on framer-motion's `animate` over a 0..1 progress. Reading the
 * store fresh on every update is what makes the travel survive the board
 * changing underneath it: a peer's op landing mid-glide moves the destination
 * rather than snapping the chip.
 */
export function useTokenTransition(tokens: Token[], epoch: number): Record<string, Pt> {
  const reduced = useReducedMotion()
  const [, force] = useState(0)

  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const displayRef = useRef<Record<string, Pt>>({})
  const fromRef = useRef<Record<string, Pt>>({})
  const animatingRef = useRef(false)
  // The epoch the effect below has already started a glide for. Written from
  // the effect and never from the render body, because StrictMode renders twice
  // and a second pass would find its own bookkeeping already done and undo the
  // hold on the line below.
  const seenEpochRef = useRef(epoch)

  // The render a formation, an undo or a redo lands on is already carrying the
  // destination: tokens and the epoch change in the same commit. Adopting them
  // here is what made the glide run from the destination to the destination, so
  // hold the previous positions for that one render and let the effect travel
  // from them. Under reduced motion there is no travel to protect and arriving
  // instantly is the answer that was asked for.
  const arriving = !reduced && epoch !== 0 && epoch !== seenEpochRef.current

  // While idle the display follows the store exactly.
  if (!animatingRef.current && !arriving) {
    const next: Record<string, Pt> = {}
    for (const t of tokens) next[t.id] = { x: t.x, y: t.y }
    displayRef.current = next
  }

  useEffect(() => {
    seenEpochRef.current = epoch
    // Epoch 0 is the board as it opened: there is nowhere to travel from.
    if (epoch === 0) return
    if (reduced) return

    fromRef.current = { ...displayRef.current }
    animatingRef.current = true

    const controls = animate(0, 1, {
      duration: DURATION,
      ease: easeOut,
      onUpdate: (p) => {
        const next: Record<string, Pt> = {}
        for (const tok of tokensRef.current) {
          const from = fromRef.current[tok.id] ?? { x: tok.x, y: tok.y }
          next[tok.id] = {
            x: from.x + (tok.x - from.x) * p,
            y: from.y + (tok.y - from.y) * p,
          }
        }
        displayRef.current = next
        force((n) => n + 1)
      },
      onComplete: () => {
        animatingRef.current = false
      },
    })

    return () => {
      controls.stop()
      animatingRef.current = false
    }
  }, [epoch, reduced])

  return displayRef.current
}
