import { useCallback, useEffect, useRef, useState } from 'react'
import { animate } from 'framer-motion'
import type Konva from 'konva'
import { clamp, lerp } from '../lib/math'
import { useReducedMotion } from './useReducedMotion'
import { isTypingTarget } from './useKeyboard'

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
  /**
   * The same fact as state, for what has to *render* differently while Space is
   * the pan modifier: the cursor, and which layers answer a press. The ref is
   * what a pointer handler reads, because it cannot be a render behind.
   */
  spaceHeld: boolean
}

/** Inputs that are not somebody typing, and so do not want Space for themselves. */
const NOT_TEXT_INPUT = new Set([
  'button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit',
])

/**
 * Whether Space, in this element, is a character.
 *
 * Not `isTypingTarget`, which answers a different question for the shortcut
 * keys and gets this one backwards in both directions: it counts a `<select>`
 * as typing, which is how a formation dropdown that had just been used could
 * swallow Space, and it counts a button as not, which is how the next
 * paragraph happened. It also trusts `isContentEditable`, which jsdom does not
 * implement, so the attribute is read as well.
 */
export function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t instanceof HTMLTextAreaElement) return true
  if (t instanceof HTMLInputElement) return !NOT_TEXT_INPUT.has(t.type)
  return (
    t.isContentEditable === true ||
    t.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null
  )
}

/** Things Space presses: the browser's idea of what it means is "activate". */
const CONTROL =
  'button, select, summary, a[href], input, textarea, ' +
  '[role="button"], [role="switch"], [role="checkbox"], [role="radio"], ' +
  '[role="menuitem"], [role="tab"], [role="option"], [role="slider"]'

/**
 * Whether a Space press is the board's to take, and not the focused control's.
 *
 * **Space is how somebody looks around the board, and the browser's default
 * for it is to press whatever has focus.** After a mouse click that is the
 * button just clicked, because Chrome leaves focus where a click puts it. So
 * every pan ended with the last toolbar button being pressed again on release:
 * Fit snapped the view back to where it started, `+ Frame` added a frame per
 * pan, Apply put every player back in the formation. That is "moving around
 * the board is broken", and it is the whole of it.
 *
 * The board takes Space unless somebody is typing, or the keyboard is the thing
 * operating a control. A control gets Space from the keyboard when it was
 * reached by it, and the only honest evidence of that is that the last thing
 * which moved focus was a Tab rather than a pointer: `:focus-visible` cannot
 * say, because Chrome reports a `<select>` as keyboard-focused after a mouse
 * click on it, which is the other half of the defect.
 *
 * `viaKeyboard` starts true. A control can only hold focus before any pointer
 * has been used by way of the keyboard or assistive technology, and neither is
 * to lose Space to a pan.
 */
export function spaceBelongsToBoard(target: EventTarget | null, viaKeyboard: boolean): boolean {
  if (!(target instanceof HTMLElement)) return true
  if (isTextEntry(target)) return false
  if (target.closest(CONTROL) === null) return true
  return !viaKeyboard
}

export function usePanZoom(): PanZoom {
  const reduced = useReducedMotion()
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)

  const spaceHeldRef = useRef(false)
  /**
   * Whether this Space is one the board took, so its release can be taken too.
   * Firefox presses a button on the keyup, so cancelling only the keydown is not
   * enough there.
   */
  const spaceClaimedRef = useRef(false)
  /** Where focus last came from. See `spaceBelongsToBoard` for why it starts true. */
  const viaKeyboardRef = useRef(true)
  const panLast = useRef<{ x: number; y: number } | null>(null)
  const scaleRef = useRef(1)
  const posRef = useRef({ x: 0, y: 0 })
  scaleRef.current = scale
  posRef.current = position

  // The live glide, cancelled whenever the user takes the viewport back.
  const tween = useRef<{ stop: () => void } | null>(null)
  const stopTweens = useCallback(() => {
    tween.current?.stop()
    tween.current = null
  }, [])

  /**
   * Spring the whole viewport back to its resting scale and offset.
   *
   * One animation over a 0..1 progress rather than three over scale, x and y:
   * a spring is linear in its target, so driving all three from one progress is
   * the same motion with a third of the machinery, and there is only one handle
   * to cancel when somebody grabs the board mid-glide.
   *
   * This is the largest movement in the product, so it is also the one that has
   * to respect a reduced-motion preference. It cannot rely on the app-level
   * `MotionConfig`, which only reaches motion components; `animate()` is
   * imperative and never sees it.
   */
  const fitPitch = useCallback(() => {
    stopTweens()
    if (reduced) {
      setScale(1)
      setPosition({ x: 0, y: 0 })
      return
    }
    const from = { s: scaleRef.current, x: posRef.current.x, y: posRef.current.y }
    tween.current = animate(0, 1, {
      ...VIEWPORT_SPRING,
      onUpdate: (p) => {
        setScale(lerp(from.s, 1, p))
        setPosition({ x: lerp(from.x, 0, p), y: lerp(from.y, 0, p) })
      },
    })
  }, [reduced, stopTweens])

  const releaseSpace = useCallback(() => {
    spaceClaimedRef.current = false
    spaceHeldRef.current = false
    setSpaceHeld(false)
  }, [])

  useEffect(() => {
    // Capture, so a press that a toolbar button or a Konva shape goes on to stop
    // is still seen: this is bookkeeping about where focus came from, not a
    // gesture, and it must not depend on who handled the press.
    const pointer = () => {
      viaKeyboardRef.current = false
    }
    // A modifier means the browser or the OS is being asked something: Ctrl+F
    // is a search, Alt+Space is the window menu. Neither is the board's.
    const modified = (e: KeyboardEvent) => e.ctrlKey || e.metaKey || e.altKey

    const down = (e: KeyboardEvent) => {
      if (e.code === 'Tab') viaKeyboardRef.current = true
      if (e.code === 'Space') {
        if (modified(e) || !spaceBelongsToBoard(e.target, viaKeyboardRef.current)) return
        // The browser's own Space is "press the focused control" and "scroll the
        // page"; the board has this one. Cancelled on every repeat, too.
        e.preventDefault()
        spaceClaimedRef.current = true
        if (!spaceHeldRef.current) {
          spaceHeldRef.current = true
          setSpaceHeld(true)
        }
        return
      }
      if (isTypingTarget(e.target)) return
      if (e.code === 'KeyF' && !modified(e)) fitPitch()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (spaceClaimedRef.current) e.preventDefault()
      releaseSpace()
    }
    // A key that goes up while another window has focus is never seen here.
    // Without these, Space held across an Alt-Tab stayed held for good, and
    // every press after it was a pan: nothing could be selected, dragged or
    // drawn until Space was pressed and released again.
    const hidden = () => {
      if (document.visibilityState === 'hidden') releaseSpace()
    }

    window.addEventListener('pointerdown', pointer, true)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', releaseSpace)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', releaseSpace)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [fitPitch, releaseSpace])

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
    spaceHeld,
  }
}
