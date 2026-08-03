import { useCallback, useEffect, useRef, useState } from 'react'
import { useBoardStore } from '../store/boardStore'
import { isTypingTarget } from './useKeyboard'
import { createDrawing, draftMode } from '../lib/drawings'
import type { DraftMode } from '../lib/drawings'
import { hitDrawings } from '../lib/erase'
import { drawingOffHalf } from '../lib/halves'
import { dist, triangleFromDrag } from '../lib/geometry'
import type { Drawing, DrawingType } from '../lib/types'

export interface Draft {
  type: DrawingType
  /**
   * Which gesture is in flight. Decided by `draftMode` at the press, and after
   * that the authority — the polygon's changes to `free` the moment the hand
   * travels, and nothing may ask the type again once a draft exists.
   */
  mode: DraftMode
  points: number[]
}

/**
 * How far the pointer must travel, in board units, before a gesture counts as a
 * drag at all.
 *
 * It is the rule a box and an arrow have always committed by — a press that
 * never moves leaves nothing behind, not even a draft — and the polygon now
 * chooses between its two modes on the same number, so a hand that shakes on a
 * tap is still a tap. A board unit is a hundredth of the pitch length, so this
 * is a little over a metre on a full pitch and roughly a dozen CSS pixels at a
 * typical zoom: past a wobble, well short of a deliberate stroke.
 */
const TRAVEL = 1.2

/**
 * The closest two traced points of a lasso may be, in board units.
 *
 * A pointermove arrives about once a frame, so two seconds of tracing is a
 * hundred-odd points — and every one of them goes into an undo snapshot, the
 * autosave payload and a realtime op every peer in the room has to apply. At
 * 0.8 units the kept samples are about a metre apart on a full pitch, which no
 * eye can tell from the raw trace once the polygon is filled.
 *
 * The pen is deliberately left undecimated. Its whole value is the fidelity of
 * the line, it is drawn as a tensioned curve rather than filled, and thinning
 * it would show.
 */
const LASSO_STEP = 0.8

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
  /**
   * The words the box opened with, and nothing ever writes to it again.
   *
   * It exists because `value` cannot answer the question the commit asks. The
   * box is a controlled input, so every keystroke rewrites `value`; comparing
   * the committed text against it therefore compares the new words with
   * themselves, which is always equal — so an edit somebody typed was refused
   * as "changed nothing" and the label kept its old text. Empty when placing,
   * where there is nothing to have changed from.
   */
  initial: string
  /** What the box holds right now: empty when placing, the words so far when editing. */
  value: string
}

/**
 * The half of a pointer event this hook needs. Typed as what is used rather
 * than as `PointerEvent`, so a test can hand it a spy without building one.
 */
type Cancellable = { preventDefault: () => void }

type Norm = { x: number; y: number } | null

/**
 * The eraser disc: where it is and how big, in board units.
 *
 * It is not a draft and deliberately not shaped like one. A draft becomes a
 * drawing; this becomes nothing at all, and the only thing that reads it is the
 * ring drawn under the pointer to say what the next sweep would take.
 */
export interface EraserDisc {
  nx: number
  ny: number
  radius: number
}

/**
 * Turns pointer gestures into drawings — or, for the eraser, into deletions —
 * while a tool other than `select` is armed. Returns `handled` from the pointer
 * handlers so the canvas knows to skip its marquee/selection behaviour.
 *
 * Both arguments are read at the moment of a gesture rather than captured, so
 * neither has to be stable across a pan, a zoom or a format change. `eraseRadius`
 * is the eraser's disc in board units: it is specified in CSS pixels, because a
 * finger has no other unit, and only the caller knows the live mapping and zoom
 * needed to turn that into board units. See `PitchCanvas`, which owns both the
 * pixel constants and the conversion.
 */
export function useDrawGesture(pointerNorm: () => Norm, eraseRadius: () => number) {
  const tool = useBoardStore((s) => s.tool)
  const drawStyle = useBoardStore((s) => s.drawStyle)
  const addDrawing = useBoardStore((s) => s.addDrawing)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)
  const deleteDrawings = useBoardStore((s) => s.deleteDrawings)
  const commit = useBoardStore((s) => s.commit)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)
  const [disc, setDisc] = useState<EraserDisc | null>(null)

  /**
   * "The pointer is armed to do something other than pick things up."
   *
   * The expression is unchanged by the eraser arriving, and that is the point
   * worth recording rather than the line itself. Three consumers ask this
   * question — the marquee must not start, the cursor must not be the arrow, and
   * a press on a label or a corner must not mean "edit me" — and the eraser
   * wants the same answer to all three as the pen does. `tool !== 'select'` is
   * therefore still exactly right, and narrowing it to "is making a mark" would
   * hand the eraser a marquee and a selection cursor over the very ink it is
   * about to remove.
   *
   * What did change is the name. It was `drawing`, which is now a claim this
   * value does not make: the eraser is armed and draws nothing.
   */
  const armed = tool !== 'select'

  // Mirrored during render rather than read from a dependency array: a pen
  // stroke or a lasso changes `draft` on every pointermove, and anything that
  // depended on it would be rebuilt that often — the window keydown listener
  // torn down and re-added a hundred times across one traced shape. `commitPoly`
  // reads the shape it is closing off this ref for exactly that reason, since
  // the effect below depends on `commitPoly` in turn.
  const draftRef = useRef<Draft | null>(null)
  const drafting = useRef(false)
  draftRef.current = draft
  drafting.current = draft !== null || textDraft !== null

  /**
   * Whether the button that started the current gesture is still down.
   *
   * Two tools consult it, and both for the same reason: they are the ones whose
   * pointermoves keep arriving when nothing is being done with them. For the
   * polygon it is the difference between a hand tracing a shape and a mouse
   * merely crossing the pitch on its way to the next corner — without this, a
   * coach who placed a corner and then moved the mouse would watch a lasso start
   * following it. For the eraser it is the difference between the disc showing
   * where it would take something and the disc actually taking it, which is a
   * far worse thing to get wrong: a mouse that erased on hover would clear the
   * board on the way to the tool that was wanted instead.
   */
  const pressed = useRef(false)

  const cancel = useCallback(() => {
    setDraft(null)
    setTextDraft(null)
  }, [])

  /**
   * Take whatever the disc is covering, as one delete.
   *
   * The board is read through `getState()` rather than subscribed to, and that
   * is not a shortcut. Subscribing to `drawings` here would re-render every
   * consumer of this hook — the whole canvas — on every mark added by anybody in
   * the room, and it would rebuild this callback on each one so that the sweep
   * that is deleting them keeps changing identity underneath itself. What is
   * needed is the board as it is at this instant, which is what `getState` is.
   *
   * `deleteDrawings` is deferred, so a sweep is one undo step; the release
   * closes it with `commit()`. Nothing is deleted directly and no state is
   * mutated around the store, because that action is also what tells the peers.
   *
   * **It can only take what is on screen, which is the same rule the marquee
   * obeys and for a worse reason.** `toNorm` is linear and unclamped, so on a
   * half view the pointer reaches the other half's board coordinates simply by
   * moving onto the bare canvas beside the pitch — a few tens of pixels outside
   * the touchline on a 1200px stage is already past the halfway line in stored
   * units. Handed the raw array, a sweep along that edge would silently destroy
   * work that nobody in the room could see, including a peer's, with no visible
   * change to point at afterwards. `DrawingLayer` drops exactly these drawings;
   * this drops the same ones through the same predicate, so what the eraser can
   * take is what the eraser is drawn over.
   */
  const eraseUnder = useCallback(
    (nx: number, ny: number, radius: number) => {
      const { drawings, view } = useBoardStore.getState()
      const shown = drawings.filter((d) => !drawingOffHalf(view.view, d))
      const hit = hitDrawings(shown, nx, ny, radius)
      if (hit.length > 0) deleteDrawings(hit, true)
    },
    [deleteDrawings],
  )

  /**
   * The press is over, whoever gets to say so.
   *
   * `onPointerUp` clears `pressed` too, and for every ordinary release that is
   * the one that runs. It is not enough on its own because the canvas calls it
   * only when the board is unlocked: an owner who takes the floor while a member
   * is mid-sweep swallows that member's release, and `pressed` would still be
   * true when the lock lifted — leaving a mouse that erases on hover, which is
   * precisely what the flag exists to prevent. So the release ends the press
   * unconditionally, and what the release is allowed to *do* stays behind the
   * lock where it belongs.
   */
  const endPress = useCallback(() => {
    pressed.current = false
  }, [])

  const commitPoly = useCallback(() => {
    /**
     * **The commit stays OUTSIDE the `setDraft` updater**, and this is the one
     * warning in this file that has to survive every redesign of the gesture:
     * React may call an updater more than once for a single update, and
     * StrictMode does it deliberately in development, so an `addDrawing` in
     * there puts two shapes on the board for one gesture. This function had
     * that bug — three corners and an Enter left two identical polygons — and
     * it is the same defect that once made a release over the canvas commit a
     * drawing twice.
     *
     * The draft comes from the ref rather than the closure so that this
     * callback stays stable across a traced shape; see `draftRef`.
     */
    const d = draftRef.current
    if (d && d.type === 'zonePoly' && d.points.length >= 6) {
      addDrawing(createDrawing('zonePoly', d.points, drawStyle))
    }
    setDraft(null)
  }, [addDrawing, drawStyle])

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
        // Escape mid-gesture means "abandon this shape", not "put the tool
        // away"; a second one disarms. It matters most to the polygon's corner
        // list, which is the one draft that outlives the release and so the one
        // that can be left sitting there needing a way out — but a triangle or
        // a lasso still under the finger is abandoned by it too, and a release
        // afterwards finds no draft and commits nothing.
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
      initial: d.text ?? '',
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
           * work destroyed by a gesture nobody made.
           *
           * **The comparison is against `initial`, and it has to be.** Against
           * `value` it compared the typed words with themselves — the box is
           * controlled, so `value` is whatever was last typed — and every real
           * edit came out equal and was thrown away. See `TextDraft.initial`.
           * What the guard is for is the other case: a box opened, read, and
           * closed unchanged should not spend an undo step or an op on the wire.
           */
          if (text && text !== textDraft.initial) updateDrawing(textDraft.id, { text })
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
      if (!armed) return false
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
        setTextDraft({ screenX, screenY, nx: n.x, ny: n.y, id: null, initial: '', value: '' })
        return true
      }
      pressed.current = true

      /**
       * The eraser starts taking things immediately, on the press itself.
       *
       * A tap on one arrow is the commonest use of it and it is not a drag, so
       * waiting for travel would make the tool feel broken for the one gesture
       * everybody tries first. There is no draft and no preview drawing to
       * create: this tool ends with less on the board than it started with, and
       * the ring that follows the pointer is the whole of what it shows.
       */
      if (tool === 'eraser') {
        const radius = eraseRadius()
        setDisc({ nx: n.x, ny: n.y, radius })
        eraseUnder(n.x, n.y, radius)
        return true
      }

      /**
       * Which gesture this press starts, asked of the type exactly once and
       * carried on the draft from here. See `draftMode`.
       *
       * `corners` is the only mode whose draft can already exist when a press
       * arrives, because it is the only one that outlives a release: a second
       * press on the Shape tool adds a corner to the list. It appends to a
       * corner list and to nothing else — a lasso caught mid-trace by a second
       * pointer is replaced rather than extended, because the two modes must
       * never both be accumulating into the same shape.
       *
       * **Nothing here commits any more**, which is why every branch can use
       * the functional form of `setDraft` freely. The triangle used to commit
       * from this handler on its third click and had to read `draft` out of the
       * closure to keep the `addDrawing` outside the updater; `commitPoly` now
       * carries that warning alone, and it is written out there.
       */
      const mode = draftMode(tool)
      if (mode === 'corners') {
        setDraft((d) =>
          d && d.type === tool && d.mode === 'corners'
            ? { ...d, points: [...d.points, n.x, n.y] }
            : { type: tool, mode, points: [n.x, n.y] },
        )
        return true
      }
      if (mode === 'apex') {
        // Six numbers from the very first frame — a triangle that has no size
        // yet — so the preview and the commit read the same shape the whole way
        // through and there is no conversion left to get wrong at the end.
        setDraft({ type: tool, mode, points: triangleFromDrag(n.x, n.y, n.x, n.y) })
        return true
      }
      // A stroke starts at one point and grows; a drag starts as a pair and
      // rubber-bands the second.
      setDraft({ type: tool, mode, points: mode === 'free' ? [n.x, n.y] : [n.x, n.y, n.x, n.y] })
      return true
    },
    // `textDraft` and `commitText` are here because the text branch commits the
    // label it is replacing, and that commit has to sit outside an updater for
    // the reason `commitPoly` gives. The shape branches use the functional form
    // and need nothing, so `draft` is no longer a dependency; this runs once per
    // press either way, while `onPointerMove` is the hot one.
    [armed, tool, pointerNorm, textDraft, commitText, eraseRadius, eraseUnder],
  )

  const onPointerMove = useCallback((): boolean => {
    /**
     * The eraser is the one tool with no draft, so it is answered before the
     * line that turns every other move away.
     *
     * The disc follows the pointer whether or not the button is down, because
     * what it is for is showing what a sweep *would* take — on a mouse that is
     * the hover, and it is the only warning there is before something
     * disappears. Only a pressed pointer actually erases.
     */
    if (tool === 'eraser') {
      const n = pointerNorm()
      if (!n) return true
      const radius = eraseRadius()
      setDisc({ nx: n.x, ny: n.y, radius })
      if (pressed.current) eraseUnder(n.x, n.y, radius)
      return true
    }
    /**
     * A gesture is in flight if there is a draft, or if a press has just made
     * one that this handler has not been re-rendered to see yet. Both halves are
     * wanted: a corner list outlives its release and has no press behind it, and
     * the first move after a press arrives before React has painted.
     */
    if (!draftRef.current && !pressed.current) return false
    const n = pointerNorm()
    if (!n) return true
    const down = pressed.current

    /**
     * **Every branch is chosen inside the updater, on the draft React hands
     * back, and never on the one this render closed over.**
     *
     * That is not style. `mode` is the one field on a draft that changes
     * mid-gesture — the polygon's turns from `corners` to `free` the moment the
     * hand travels — and pointermove is not a discrete event, so React is free
     * to batch a run of them and re-render once at the end. Choosing the branch
     * from the closure therefore routes every move between the change and the
     * next paint to the branch the gesture has already left: a lasso's samples
     * arrive at the corner branch, which refuses them because the draft is no
     * longer two numbers long, and they are dropped in silence. Traced fast
     * enough — which is to say, traced — a lasso came out as a three-point
     * splinter with no error anywhere to say why.
     *
     * The stale *ref* is no better than the stale closure, since both are
     * written during render. The updater's argument is the only value that is
     * always current, so the dispatch lives in there.
     *
     * It has to stay pure to sit there. React may run an updater more than once
     * for one update and StrictMode does it deliberately, so nothing in here may
     * add a drawing or touch the store — every branch below returns a draft and
     * does nothing else. That is the same rule `commitPoly` carries, which is
     * why the commit is not here.
     */
    setDraft((d) => {
      if (!d) return d
      if (d.mode === 'drag') return { ...d, points: [d.points[0], d.points[1], n.x, n.y] }
      // `points[0..1]` is the apex, which is exactly where the press landed, so
      // the triangle is regrown from the original press point on every frame
      // rather than from the last one. Nothing accumulates and nothing drifts.
      if (d.mode === 'apex') {
        return { ...d, points: triangleFromDrag(d.points[0], d.points[1], n.x, n.y) }
      }
      if (d.mode === 'free') {
        const i = d.points.length - 2
        // The pen keeps every sample and the lasso does not; see `LASSO_STEP`.
        // Handing back the draft unchanged is what makes the thinning free
        // rather than merely cheap: React bails out of the re-render entirely,
        // so a slow finger costs nothing at all.
        if (d.type !== 'pen' && dist(d.points[i], d.points[i + 1], n.x, n.y) < LASSO_STEP) return d
        return { ...d, points: [...d.points, n.x, n.y] }
      }
      /**
       * A corner list. A corner is where somebody put it, so a move must never
       * rubber-band one, and the only thing that can happen here is the polygon
       * turning into a lasso.
       *
       * Only the press that opened the shape may do that, only while it is
       * still down, and only before a second corner exists — which is what
       * keeps the two modes from ever accumulating at once. After that the
       * shape is a corner list until it is closed or abandoned.
       */
      if (!down || d.points.length !== 2) return d
      if (dist(d.points[0], d.points[1], n.x, n.y) <= TRAVEL) return d
      return { ...d, mode: 'free', points: [...d.points, n.x, n.y] }
    })
    return true
    // `draft` is deliberately not a dependency. Nothing above reads it any more,
    // and this is the hot handler — a hundred rebuilds across one traced shape
    // bought nothing even when it was correct.
  }, [pointerNorm, tool, eraseRadius, eraseUnder])

  const onPointerUp = useCallback((): boolean => {
    pressed.current = false
    /**
     * The sweep is over, so close the undo step it has been holding open.
     *
     * `commit()` on a run that erased nothing is a no-op — it returns on a null
     * `_pending` — which is what makes this safe to call for every release with
     * the eraser armed rather than only for the ones that found something.
     */
    if (tool === 'eraser') {
      commit()
      return true
    }
    if (!draft) return false
    // A corner list outlives the release: it ends on Enter, on a double-click
    // or double-tap, or on Escape. Answering `handled` keeps the marquee out of
    // a gesture that is still going on.
    if (draft.mode === 'corners') return true

    const p = draft.points
    let meaningful: boolean
    if (draft.mode === 'free') {
      // Three points, traced or drawn: fewer is not a shape and not a stroke.
      meaningful = p.length >= 6
    } else if (draft.mode === 'apex') {
      // The drag itself, recovered from the corners. The base is centred on
      // wherever the pointer reached, so its midpoint is the far end of the
      // drag — and stays so whatever the base half-width becomes. Same
      // threshold as every other drag, so a press that never travelled leaves
      // nothing behind, not even a stranded draft.
      meaningful = dist(p[0], p[1], (p[2] + p[4]) / 2, (p[3] + p[5]) / 2) > TRAVEL
    } else {
      meaningful = dist(p[0], p[1], p[2], p[3]) > TRAVEL
    }

    if (meaningful) addDrawing(createDrawing(draft.type, p, drawStyle))
    setDraft(null)
    return true
  }, [draft, addDrawing, drawStyle, tool, commit])

  // A live preview of the in-progress gesture, shaped like a real drawing —
  // literally so, since every mode keeps the draft in the form the commit will
  // store. A triangle grows under the finger because its draft is already the
  // three corners, not a drag that something downstream would have to derive
  // them from and could derive differently.
  const preview: Drawing | null = draft
    ? { ...createDrawing(draft.type, draft.points, drawStyle), id: '__draft__' }
    : null

  return {
    armed,
    draft,
    preview,
    /**
     * Gated on the tool rather than cleared when it changes, so there is no
     * moment where a stale ring is still on the pitch because a disarm forgot to
     * tidy up after itself. Putting the eraser away is one thing, and it happens
     * from the bar, from Escape and from a peer replacing the board.
     */
    eraser: tool === 'eraser' ? disc : null,
    textDraft,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    endPress,
    commitPoly,
    editText,
    setTextValue,
    commitText,
    blurText,
    cancel,
  }
}
