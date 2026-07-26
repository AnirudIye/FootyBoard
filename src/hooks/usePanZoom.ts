import { useCallback, useEffect, useRef, useState } from 'react'
import { animate } from 'framer-motion'
import type Konva from 'konva'
import { clamp } from '../lib/math'

const MIN_SCALE = 0.3
const MAX_SCALE = 3
const ZOOM_FACTOR = 1.08

const VIEWPORT_SPRING = { type: 'spring', stiffness: 190, damping: 26, mass: 0.9 } as const

export interface PanZoom {
  scale: number
  position: { x: number; y: number }
  panning: boolean
  onWheel: (e: Konva.KonvaEventObject<WheelEvent>) => void
  onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => void
  onPointerMove: (e: Konva.KonvaEventObject<PointerEvent>) => void
  onPointerUp: () => void
  fitPitch: () => void
  /** True while space is held, so callers can suppress token interactions. */
  spaceHeldRef: React.MutableRefObject<boolean>
}

export function usePanZoom(): PanZoom {
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)

  const spaceHeldRef = useRef(false)
  const panLast = useRef<{ x: number; y: number } | null>(null)
  const scaleRef = useRef(1)
  const posRef = useRef({ x: 0, y: 0 })
  scaleRef.current = scale
  posRef.current = position

  // Live tweens, cancelled whenever the user takes over the viewport.
  const tweens = useRef<{ stop: () => void }[]>([])
  const stopTweens = useCallback(() => {
    for (const t of tweens.current) t.stop()
    tweens.current = []
  }, [])

  /** Spring the viewport to a target rather than snapping to it. */
  const glideTo = useCallback(
    (nextScale: number, nextPos: { x: number; y: number }) => {
      stopTweens()
      tweens.current = [
        animate(scaleRef.current, nextScale, {
          ...VIEWPORT_SPRING,
          onUpdate: (v) => setScale(v),
        }),
        animate(posRef.current.x, nextPos.x, {
          ...VIEWPORT_SPRING,
          onUpdate: (v) => setPosition((p) => ({ ...p, x: v })),
        }),
        animate(posRef.current.y, nextPos.y, {
          ...VIEWPORT_SPRING,
          onUpdate: (v) => setPosition((p) => ({ ...p, y: v })),
        }),
      ]
    },
    [stopTweens],
  )

  const fitPitch = useCallback(() => {
    glideTo(1, { x: 0, y: 0 })
  }, [glideTo])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.code === 'Space') spaceHeldRef.current = true
      if (e.code === 'KeyF') fitPitch()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [fitPitch])

  useEffect(() => stopTweens, [stopTweens])

  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault()
      const stage = e.target.getStage()
      if (!stage) return
      const pointer = stage.getPointerPosition()
      if (!pointer) return
      stopTweens()

      const oldScale = scaleRef.current
      const pos = posRef.current
      const worldX = (pointer.x - pos.x) / oldScale
      const worldY = (pointer.y - pos.y) / oldScale
      const zoomingIn = e.evt.deltaY < 0
      const next = clamp(
        zoomingIn ? oldScale * ZOOM_FACTOR : oldScale / ZOOM_FACTOR,
        MIN_SCALE,
        MAX_SCALE,
      )
      setScale(next)
      setPosition({ x: pointer.x - worldX * next, y: pointer.y - worldY * next })
    },
    [stopTweens],
  )

  const onPointerDown = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      const middle = e.evt.button === 1
      if (spaceHeldRef.current || middle) {
        e.evt.preventDefault()
        stopTweens()
        setPanning(true)
        panLast.current = { x: e.evt.clientX, y: e.evt.clientY }
      }
    },
    [stopTweens],
  )

  const onPointerMove = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    if (!panLast.current) return
    const dx = e.evt.clientX - panLast.current.x
    const dy = e.evt.clientY - panLast.current.y
    panLast.current = { x: e.evt.clientX, y: e.evt.clientY }
    setPosition((p) => ({ x: p.x + dx, y: p.y + dy }))
  }, [])

  const onPointerUp = useCallback(() => {
    setPanning(false)
    panLast.current = null
  }, [])

  return {
    scale,
    position,
    panning,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fitPitch,
    spaceHeldRef,
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}
