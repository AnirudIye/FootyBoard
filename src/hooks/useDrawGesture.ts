import { useCallback, useEffect, useRef, useState } from 'react'
import { useBoardStore } from '../store/boardStore'
import { isTypingTarget } from './useKeyboard'
import { createDrawing, isDragType, isClickType, CLICK_CORNERS } from '../lib/drawings'
import { dist } from '../lib/geometry'
import type { Drawing, DrawingType } from '../lib/types'

export interface Draft {
  type: DrawingType
  points: number[]
}

export interface TextDraft {
  screenX: number
  screenY: number
  nx: number
  ny: number
  /**
   * The label being edited, or null when the box is placing a new one. It is
   * the one field that decides between `addDrawing` and `updateDrawing`, so
   * that "place a label" and "fix a label" are one box and one commit path
   * rather than two that would drift.
   */
  id: string | null
  /** What the box opens holding: empty when placing, the words so far when editing. */
  value: string
}

/**
 * The half of a pointer event this hook needs. Typed as what is used rather
 * than as `PointerEvent`, so a test can hand it a spy without building one.
 */
type Cancellable = { preventDefault: () => void }

type Norm = { x: number; y: number } | null

/**
 * Turns pointer gestures into drawings while a draw tool is active. Returns
 * `handled` from the pointer handlers so the canvas knows to skip its
 * marquee/selection behaviour.
 */
export function useDrawGesture(pointerNorm: () => Norm) {
  const tool = useBoardStore((s) => s.tool)
  const drawStyle = useBoardStore((s) => s.drawStyle)
  const addDrawing = useBoardStore((s) => s.addDrawing)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)

  const drawing = tool !== 'select'

  const cancel = useCallback(() => {
    setDraft(null)
    setTextDraft(null)
  }, [])

  const commitPoly = useCallback(() => {
    setDraft((d) => {
      if (d && d.type === 'zonePoly' && d.points.length >= 6) {
        addDrawing(createDrawing('zonePoly', d.points, drawStyle))
      }
      return null
    })
  }, [addDrawing, drawStyle])

  // Mirrored during render rather than read from the effect's deps: a pen stroke
  // changes `draft` on every pointermove, and depending on it would tear the
  // window listener down and rebuild it that often.
  const drafting = useRef(false)
  drafting.current = draft !== null || textDraft !== null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The same guard `useKeyboard` applies, and imported from there rather
      // than written again, because two copies is two places to forget
      // `contentEditable`. Without it, arming a tool, editing a player name and
      // pressing Escape to leave the field disarmed the tool silently: Escape
      // in a text field means "leave this field", never "put my tool away".
      // Enter is covered by the same return, or typing a message would close a
      // polygon behind the panel.
      if (isTypingTarget(e.target)) return

      if (e.key === 'Escape') {
        // zonePoly is the one multi-click gesture, so Escape mid-gesture means
        // "abandon this shape", not "put the tool away". A second one disarms.
        if (drafting.current) cancel()
        else useBoardStore.getState().setTool('select')
      }
      if (e.key === 'Enter') commitPoly()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel, commitPoly])

  /**
   * The box is controlled, so the words live here rather than in the DOM node.
   *
   * That is not tidiness. With the opening press cancelled, focus never leaves
   * the box, so no blur arrives to carry the value out of an uncontrolled
   * input, and every path that closes the box other than a blur — placing the
   * next label, most of all — would have had nowhere to read it from.
   */
  const setTextValue = useCallback((value: string) => {
    setTextDraft((d) => (d ? { ...d, value } : d))
  }, [])

  /**
   * Reopen the box over a label that already exists, holding its words.
   *
   * The same box and the same commit, because "place a label" and "fix a
   * label" differ by one field. A second editor would be a second set of rules
   * about trimming, about Escape and about what an empty box means, and this
   * repo has been bitten five times by a rule written out twice.
   */
  const editText = useCallback((d: Drawing, screenX: number, screenY: number) => {
    setTextDraft({
      screenX,
      screenY,
      nx: d.points[0],
      ny: d.points[1],
      id: d.id,
      value: d.text ?? '',
    })
  }, [])

  const commitText = useCallback(
    (value: string) => {
      const text = value.trim()
      if (textDraft) {
        if (textDraft.id) {
          /**
           * An empty edit leaves the label alone rather than deleting it.
           * Delete is a key that says so, and a label lost to a cleared box is
           * work destroyed by a gesture nobody made. Comparing against the
           * words it opened with keeps a look that changed nothing out of the
           * undo stack and off the wire.
           */
          if (text && text !== textDraft.value) updateDrawing(textDraft.id, { text })
        } else if (text) {
          addDrawing(createDrawing('text', [textDraft.nx, textDraft.ny], drawStyle, { text }))
        }
      }
      setTextDraft(null)
    },
    [textDraft, addDrawing, updateDrawing, drawStyle],
  )

  /**
   * A blur is not a decision, which is why it is not simply `commitText`.
   *
   * Something typed and then clicked away from is meant, so it commits. An
   * *empty* blur is the box being left, and closing on it is what made the
   * focus race fatal rather than merely ugly: whatever steals focus in the
   * frame the box opens takes the box with it. Leaving the draft standing
   * costs nothing, since Escape still abandons it — this hook's own window
   * listener answers even when focus has gone to the body — and the next press
   * replaces it.
   */
  const blurText = useCallback(
    (value: string) => {
      if (value.trim()) commitText(value)
    },
    [commitText],
  )

  const onPointerDown = useCallback(
    (screenX: number, screenY: number, evt?: Cancellable): boolean => {
      if (!drawing) return false
      const n = pointerNorm()
      if (!n) return true

      if (tool === 'text') {
        /**
         * Cancel the press that opens the box, or the box closes before anybody
         * can type in it. This is the whole of the "the Text tool does nothing"
         * defect, and it is a focus race rather than anything in the drawing
         * pipeline.
         *
         * The press opens a real DOM `<input>`; the browser then dispatches the
         * compatibility `mousedown` for that same press, whose default action
         * moves focus to the nearest focusable ancestor of the canvas, which is
         * the document body. React wires `onBlur` to `focusout`, so it fires
         * within the frame with an empty value and the box takes itself away.
         * Preventing the pointerdown's default suppresses the compatibility
         * mouse events, so focus is never taken.
         *
         * **Only this branch, and that is not caution.** Konva drives both node
         * dragging and the stage's `dblclick` off those same compatibility
         * events, and the stage's `onDblClick` is what closes a polygon.
         * Cancelling every draw press would trade this bug for that one.
         *
         * **And because focus is never taken, no blur is coming**, which is why
         * the press commits the box it is replacing rather than leaving that to
         * the blur that used to arrive. Placing a second label is the ordinary
         * way to finish the first one, and before this line it silently threw
         * the first one's words away.
         */
        evt?.preventDefault()
        if (textDraft) commitText(textDraft.value)
        setTextDraft({ screenX, screenY, nx: n.x, ny: n.y, id: null, value: '' })
        return true
      }
      /**
       * The click-placed shapes: one corner per press, and the only difference
       * between them is what ends it.
       *
       * A triangle closes itself on its third corner. Three points is the whole
       * of what a triangle is, so there is nothing left to decide once they are
       * down, and asking for Enter as well would be asking twice for the same
       * answer. A polygon has no such number and keeps its Enter.
       *
       * **The commit happens here and not inside the `setDraft` updater**, which
       * is why this reads `draft` rather than using the functional form the
       * polygon branch can afford. React may call an updater more than once for
       * one update, and StrictMode does exactly that in development, so an
       * `addDrawing` inside one would put two triangles on the board for one
       * click. That is the same class of bug as the double-committed drawing
       * `useWindowPointerUp` was written to stop.
       */
      if (isClickType(tool)) {
        const placed = draft && draft.type === tool ? draft.points : []
        const points = [...placed, n.x, n.y]
        const needed = CLICK_CORNERS[tool]

        if (needed && points.length >= needed * 2) {
          addDrawing(createDrawing(tool, points.slice(0, needed * 2), drawStyle))
          setDraft(null)
        } else {
          setDraft({ type: tool, points })
        }
        return true
      }
      if (tool === 'pen') {
        setDraft({ type: 'pen', points: [n.x, n.y] })
        return true
      }
      setDraft({ type: tool, points: [n.x, n.y, n.x, n.y] })
      return true
    },
    // `draft` is a dependency now, because the triangle's commit reads it rather
    // than going through a `setDraft` updater, and `textDraft`/`commitText` for
    // the same reason on the text branch. This runs once per press, so
    // rebuilding it per click costs nothing; `onPointerMove` is the hot one and
    // still does not depend on any of them.
    [drawing, tool, pointerNorm, draft, addDrawing, drawStyle, textDraft, commitText],
  )

  const onPointerMove = useCallback((): boolean => {
    if (!draft) return false
    const n = pointerNorm()
    if (!n) return true
    if (draft.type === 'pen') {
      setDraft((d) => (d ? { ...d, points: [...d.points, n.x, n.y] } : d))
    } else if (!isClickType(draft.type)) {
      // A click-placed shape must not rubber-band: its second corner is a corner
      // somebody put there, not one the pointer is dragging out.
      setDraft((d) => (d ? { ...d, points: [d.points[0], d.points[1], n.x, n.y] } : d))
    }
    return true
  }, [draft, pointerNorm])

  const onPointerUp = useCallback((): boolean => {
    if (!draft) return false
    // Click-placed shapes stay open across the release: a polygon until Enter,
    // a triangle until its third corner, both of which happen on pointer *down*.
    if (isClickType(draft.type)) return true

    const p = draft.points
    const meaningful =
      draft.type === 'pen'
        ? p.length >= 6
        : isDragType(draft.type) && dist(p[0], p[1], p[2], p[3]) > 1.2

    if (meaningful) addDrawing(createDrawing(draft.type, p, drawStyle))
    setDraft(null)
    return true
  }, [draft, addDrawing, drawStyle])

  // A live preview of the in-progress gesture, shaped like a real drawing.
  const preview: Drawing | null = draft
    ? { ...createDrawing(draft.type, draft.points, drawStyle), id: '__draft__' }
    : null

  return {
    drawing,
    draft,
    preview,
    textDraft,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    commitPoly,
    editText,
    setTextValue,
    commitText,
    blurText,
    cancel,
  }
}
