import { useCallback, useEffect, useRef, useState } from 'react'
import Konva from 'konva'
import type { RefObject } from 'react'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import type { PitchMapping } from './pitchMapping'

/**
 * The physical half of dragging a token: a pickup you can feel, and a touchline
 * that gives rather than stops dead.
 *
 * The store keeps clamping positions into the board, and it has to: that is
 * data, and every peer in the room has to agree on it. So the give lives
 * entirely in the view. While a drag is running the node's position belongs to
 * Konva rather than to React, because otherwise the clamped value flows straight
 * back down as an `x` prop and pins the chip to the line. `place()` is what
 * hands the position over and back: it reports the pickup value for as long as
 * the drag and the spring home are in charge, so react-konva sees no change and
 * writes nothing over the top.
 */

// How far past the line a token may be pulled, in board units, and how hard it
// resists getting there. The curve is asymptotic: the first unit of overshoot
// is nearly free, the eighth is nearly impossible.
const OVER = 8
const RESIST = 0.55

const resist = (o: number) => (o * OVER * RESIST) / (OVER + RESIST * Math.abs(o))
const soft = (v: number) => (v > 100 ? 100 + resist(v - 100) : v < 0 ? -resist(-v) : v)

const LIFT = 1.06
const PICKUP_S = 0.12
const SETTLE_S = 0.25
const HOME_S = 0.35

interface Pt {
  x: number
  y: number
}

export interface TokenDrag {
  /** Goes on the token's `<Group>`: what lifts, and what a drag moves. */
  ref: RefObject<Konva.Group | null>
  /**
   * Goes on the shape the drop shadow comes from. Shadows are a Shape property
   * in Konva and not a Group one, so the lift needs both nodes. A callback
   * rather than an object, so it fits whichever shape a token happens to be.
   */
  bodyRef: (node: Konva.Shape | null) => void
  /** Where React should say the node is, given where the store says it is. */
  place: (live: Pt) => Pt
  dragBoundFunc: (abs: Pt) => Pt
  /** pointerdown. */
  pickUp: () => void
  /** dragstart. */
  beginDrag: () => void
  /** dragend, with the position the store settled on. */
  endDrag: (home: Pt) => void
  /** pointerup, which only has work to do when the press never became a drag. */
  putDown: () => void
}

export function useTokenDrag(mapping: PitchMapping, radius: number): TokenDrag {
  const ref = useRef<Konva.Group>(null)
  const body = useRef<Konva.Shape | null>(null)
  const bodyRef = useCallback((node: Konva.Shape | null) => {
    body.current = node
  }, [])
  const tweens = useRef<Konva.Tween[]>([])
  const pickedUpAt = useRef<Pt>({ x: 0, y: 0 })
  const lifted = useRef(false)
  const dragging = useRef(false)
  const [free, setFree] = useState(false)
  const reduced = useReducedMotion()

  const stop = () => {
    for (const t of tweens.current) t.destroy()
    tweens.current = []
  }

  useEffect(() => stop, [])

  const run = (node: Konva.Node | null, to: Record<string, number>, duration: number, onEnd?: () => void) => {
    if (!node) return
    if (reduced) {
      node.setAttrs(to)
      onEnd?.()
      return
    }
    const tween = new Konva.Tween({ node, ...to, duration, easing: Konva.Easings.EaseOut, onFinish: onEnd })
    tweens.current.push(tween)
    tween.play()
  }

  const settle = () => {
    run(ref.current, { scaleX: 1, scaleY: 1 }, SETTLE_S)
    run(body.current, { shadowBlur: 0, shadowOpacity: 0, shadowOffsetY: 0 }, SETTLE_S)
  }

  return {
    ref,
    bodyRef,

    place: (live) => {
      if (free) return pickedUpAt.current
      pickedUpAt.current = live
      return live
    },

    dragBoundFunc: (abs) => {
      const parent = ref.current?.getParent()
      if (!parent) return abs
      // The position arrives in absolute stage space, which pan and zoom have
      // already been applied to; the mapping speaks the layer's own coordinates.
      const toStage = parent.getAbsoluteTransform()
      const local = toStage.copy().invert().point(abs)
      const n = mapping.toNorm(local.x, local.y)
      return toStage.point(mapping.toPx(soft(n.x), soft(n.y)))
    },

    pickUp: () => {
      stop()
      lifted.current = true
      body.current?.shadowColor('#000')
      run(ref.current, { scaleX: LIFT, scaleY: LIFT }, PICKUP_S)
      run(
        body.current,
        { shadowBlur: radius * 0.9, shadowOpacity: 0.45, shadowOffsetY: radius * 0.22 },
        PICKUP_S,
      )
    },

    beginDrag: () => {
      dragging.current = true
      setFree(true)
    },

    endDrag: (home) => {
      dragging.current = false
      lifted.current = false
      stop()
      settle()
      run(ref.current, { x: home.x, y: home.y }, HOME_S, () => setFree(false))
    },

    // Whether dragend or pointerup lands first is not something Konva promises,
    // so the one that matters claims the release and the other finds nothing to
    // do. A press that never moved only ever gets this one.
    putDown: () => {
      if (dragging.current || !lifted.current) return
      lifted.current = false
      stop()
      settle()
    },
  }
}
