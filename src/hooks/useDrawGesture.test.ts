import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, renderHook, fireEvent } from '@testing-library/react'
import { useDrawGesture } from './useDrawGesture'
import { useBoardStore } from '../store/boardStore'
import { createDrawing } from '../lib/drawings'

const at = () => ({ x: 50, y: 50 })

/**
 * The eraser disc, in board units.
 *
 * The hook takes it as a function because in the real board it is a constant
 * number of CSS pixels converted through the live mapping and zoom, and both of
 * those change under the pointer. Three units is a bit over three metres on a
 * full pitch: near enough what a fingertip covers, and far short of anything a
 * test would have to squint at.
 */
const radius = () => 3

describe('useDrawGesture: Escape', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('select')
  })

  it('disarms the tool when no gesture is in progress', () => {
    renderHook(() => useDrawGesture(at, radius))
    act(() => useBoardStore.getState().setTool('pen'))

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('select')
  })

  it('ignores Escape from a text field, which means leave the field', () => {
    renderHook(() => useDrawGesture(at, radius))
    act(() => useBoardStore.getState().setTool('pen'))

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    input.remove()

    expect(useBoardStore.getState().tool).toBe('pen')
  })

  it('abandons a polygon in progress but keeps the tool armed', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => useBoardStore.getState().setTool('zonePoly'))
    act(() => {
      result.current.onPointerDown(10, 10)
    })
    expect(result.current.draft).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('zonePoly')
    expect(result.current.draft).toBeNull()
  })
})

/**
 * A label: click the pitch, type, press Enter.
 *
 * Text is the one tool whose gesture leaves the canvas entirely — the press
 * opens a real DOM input positioned over the stage, and what commits is a
 * keystroke in that input rather than anything the pointer does. Nothing
 * asserted this end to end, which is how it came to be reported as simply not
 * working.
 */
describe('useDrawGesture: text labels', () => {
  const at = () => ({ x: 40, y: 60 })
  const drawings = () => useBoardStore.getState().drawings

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('text')
  })

  it('opens a text draft where the pointer went down', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))

    act(() => {
      result.current.onPointerDown(300, 200)
    })

    // The screen coordinates position the input; the normalized pair is where
    // the label will actually live on the pitch. `id: null` is the field that
    // says this box is placing rather than fixing.
    expect(result.current.textDraft).toEqual({
      screenX: 300,
      screenY: 200,
      nx: 40,
      ny: 60,
      id: null,
      value: '',
    })
    expect(drawings()).toHaveLength(0)
  })

  it('commits what was typed, as a text drawing at that point', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => {
      result.current.onPointerDown(300, 200)
    })

    act(() => {
      result.current.commitText('PRESS HIGH')
    })

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].type).toBe('text')
    expect(drawings()[0].text).toBe('PRESS HIGH')
    expect(drawings()[0].points).toEqual([40, 60])
    expect(result.current.textDraft).toBeNull()
  })

  it('adds nothing for an empty label, and closes the draft either way', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => {
      result.current.onPointerDown(300, 200)
    })

    act(() => {
      result.current.commitText('   ')
    })

    expect(drawings()).toHaveLength(0)
    expect(result.current.textDraft).toBeNull()
  })
})

/**
 * The focus race, asserted at the only two points jsdom can reach.
 *
 * **Neither of these proves the feature works, and saying so is the point.**
 * `dispatchEvent` produces untrusted events, which do not run default actions,
 * so the focus is never stolen in jsdom and a script "reproducing" the bug
 * reports that the tool is fine. What is assertable is the contract: that the
 * press which opens the box cancels itself, and that an empty blur does not
 * take the box away. The proof that a label can be placed is a person clicking
 * the pitch.
 */
describe('useDrawGesture: the press that opens the typing box', () => {
  const at = () => ({ x: 40, y: 60 })
  const drawings = () => useBoardStore.getState().drawings

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
  })

  it('cancels the press, so nothing can take focus off the box it just opened', () => {
    useBoardStore.getState().setTool('text')
    const { result } = renderHook(() => useDrawGesture(at, radius))
    const evt = { preventDefault: vi.fn() }

    act(() => {
      result.current.onPointerDown(300, 200, evt)
    })

    expect(evt.preventDefault).toHaveBeenCalledOnce()
    expect(result.current.textDraft).not.toBeNull()
  })

  /**
   * Cancelling the press also suppresses `click` and `dblclick`, and the
   * stage's `onDblClick` is what closes a polygon. So the cancellation has to
   * stay inside the text branch, and that is worth an assertion rather than a
   * comment: the two are one line apart.
   */
  it('leaves every other draw gesture uncancelled, or a polygon could not close', () => {
    useBoardStore.getState().setTool('zonePoly')
    const { result } = renderHook(() => useDrawGesture(at, radius))
    const evt = { preventDefault: vi.fn() }

    act(() => {
      result.current.onPointerDown(300, 200, evt)
    })

    expect(evt.preventDefault).not.toHaveBeenCalled()
  })

  it('keeps an empty box standing when it is blurred, rather than discarding it', () => {
    useBoardStore.getState().setTool('text')
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => {
      result.current.onPointerDown(300, 200)
    })

    act(() => {
      result.current.blurText('')
    })

    expect(result.current.textDraft).not.toBeNull()
    expect(drawings()).toHaveLength(0)
  })

  /**
   * The cost of cancelling the press, paid rather than left lying.
   *
   * With focus never leaving the box there is no blur coming, so the gesture
   * that used to commit a label — clicking the next spot — had nothing behind
   * it and threw the words away. Placing several labels in a row is the
   * ordinary way to use this tool, so this is not an edge.
   */
  it('commits the label in hand when the next one is placed', () => {
    useBoardStore.getState().setTool('text')
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => {
      result.current.onPointerDown(300, 200)
    })
    act(() => {
      result.current.setTextValue('PRESS HIGH')
    })

    act(() => {
      result.current.onPointerDown(400, 250)
    })

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].text).toBe('PRESS HIGH')
    // ...and the box that opened is the new one, empty and at the new spot.
    expect(result.current.textDraft).toEqual({
      screenX: 400,
      screenY: 250,
      nx: 40,
      ny: 60,
      id: null,
      value: '',
    })
  })

  it('commits on a blur that has something in it, since that was meant', () => {
    useBoardStore.getState().setTool('text')
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => {
      result.current.onPointerDown(300, 200)
    })

    act(() => {
      result.current.blurText('HIGH LINE')
    })

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].text).toBe('HIGH LINE')
    expect(result.current.textDraft).toBeNull()
  })
})

/**
 * Fixing a label's words, which until now meant deleting it and typing it
 * again. The same box and the same commit as placing one; `id` is the whole of
 * the difference.
 */
describe('useDrawGesture: editing a placed label', () => {
  const at = () => ({ x: 40, y: 60 })
  const drawings = () => useBoardStore.getState().drawings
  const undoSteps = () => useBoardStore.getState().history.past.length

  const placeLabel = (text: string) => {
    useBoardStore.getState().setTool('text')
    const { result } = renderHook(() => useDrawGesture(at, radius))
    act(() => {
      result.current.onPointerDown(300, 200)
    })
    act(() => {
      result.current.commitText(text)
    })
    return result
  }

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
  })

  it('opens the box over the label, holding the words it already has', () => {
    const result = placeLabel('PRESS HIGH')
    const label = drawings()[0]
    act(() => useBoardStore.getState().setTool('select'))

    act(() => {
      result.current.editText(label, 120, 90)
    })

    expect(result.current.textDraft).toEqual({
      screenX: 120,
      screenY: 90,
      // The label's own point, not the pointer's: an edit must not move it.
      nx: 40,
      ny: 60,
      id: label.id,
      value: 'PRESS HIGH',
    })
  })

  it('rewrites the label in place rather than adding a second one', () => {
    const result = placeLabel('PRESS HIGH')
    const label = drawings()[0]
    act(() => {
      result.current.editText(label, 120, 90)
    })

    act(() => {
      result.current.commitText('PRESS MID')
    })

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].id).toBe(label.id)
    expect(drawings()[0].text).toBe('PRESS MID')
    expect(result.current.textDraft).toBeNull()
  })

  /** Delete is a key that says so. A cleared box is not a request to destroy. */
  it('leaves the label alone when the box is emptied and committed', () => {
    const result = placeLabel('PRESS HIGH')
    const label = drawings()[0]
    act(() => {
      result.current.editText(label, 120, 90)
    })

    act(() => {
      result.current.commitText('   ')
    })

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].text).toBe('PRESS HIGH')
  })

  it('spends no undo step on an edit that changed nothing', () => {
    const result = placeLabel('PRESS HIGH')
    const label = drawings()[0]
    const before = undoSteps()

    act(() => {
      result.current.editText(label, 120, 90)
    })
    act(() => {
      result.current.commitText('  PRESS HIGH  ')
    })

    expect(undoSteps()).toBe(before)
    expect(drawings()[0].text).toBe('PRESS HIGH')
  })
})

/**
 * A gesture harness for the two zone tools, which are the only ones whose
 * behaviour depends on where the pointer went between the press and the release.
 *
 * `useDrawGesture` reads the pointer through the function it is given rather
 * than off the event, so a test moves the pointer by moving `cursor` and then
 * telling the hook a pointer event happened. The screen coordinates handed to
 * `onPointerDown` are only used to position the text box and are ignored here.
 */
const gestures = () => {
  let cursor = { x: 0, y: 0 }
  type Hook = { current: ReturnType<typeof useDrawGesture> }
  const at = () => cursor
  const press = (r: Hook, x: number, y: number) => {
    cursor = { x, y }
    act(() => {
      r.current.onPointerDown(x, y)
    })
  }
  const move = (r: Hook, x: number, y: number) => {
    cursor = { x, y }
    act(() => {
      r.current.onPointerMove()
    })
  }
  const release = (r: Hook) =>
    act(() => {
      r.current.onPointerUp()
    })
  const tap = (r: Hook, x: number, y: number) => {
    press(r, x, y)
    release(r)
  }
  /**
   * A run of moves inside ONE `act`, which is how a traced shape really arrives.
   *
   * `move` flushes React between samples and a hand does not. `pointermove` is
   * not a discrete event, so the browser delivers a burst of them and React
   * re-renders once at the end — which means a handler choosing its branch from
   * the render closure is reading a draft several samples out of date. Sampling
   * one at a time hides that completely, and it is why a lasso that every
   * existing test called correct came out of a real browser as a three-point
   * splinter. This is the only way to reproduce it in jsdom.
   */
  const sweep = (r: Hook, pts: [number, number][]) =>
    act(() => {
      for (const [x, y] of pts) {
        cursor = { x, y }
        r.current.onPointerMove()
      }
    })
  return { at, press, move, release, tap, sweep }
}

/**
 * The triangle: press to plant the point, drag to open the shape out behind it.
 *
 * It has now been all three things — a box drag with a derived apex, three
 * separate clicks, and this — so the assertions worth having are the ones that
 * say which. Three clicks were precise and fiddly, and unusable on a phone
 * where the tooltip explaining them cannot be reached; a drag out of a single
 * planted point is one gesture, and it is what the product owner asked for in
 * those words.
 */
describe('useDrawGesture: the triangle is a drag out of its own point', () => {
  const { at, press, move, release, tap } = gestures()
  const drawings = () => useBoardStore.getState().drawings

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('zoneTriangle')
  })

  /**
   * Under StrictMode deliberately, and the count is half the assertion.
   *
   * React may invoke a state updater more than once for a single update and
   * StrictMode does it on purpose in development, so any `addDrawing` that
   * slipped inside a `setDraft` updater would put two triangles on the board
   * for this one gesture — the same defect that once made a release over the
   * canvas commit a drawing twice, and that `commitPoly` was actually carrying.
   */
  it('commits exactly one triangle of three corners for one drag', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode })

    press(result, 20, 20)
    move(result, 20, 45)
    move(result, 20, 60)
    release(result)

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].type).toBe('zoneTriangle')
    // Six numbers, not four: the corners themselves, so nothing downstream has
    // to derive them and nothing can derive them differently.
    expect(drawings()[0].points).toHaveLength(6)
    // The apex is the press, untouched by the drag that grew the base away
    // from it, and the base is centred on where the finger ended up.
    expect(drawings()[0].points.slice(0, 2)).toEqual([20, 20])
    const p = drawings()[0].points
    expect((p[2] + p[4]) / 2).toBeCloseTo(20, 9)
    expect((p[3] + p[5]) / 2).toBeCloseTo(60, 9)
    expect(result.current.draft).toBeNull()
  })

  /** The whole point of doing it this way: what you see is what gets stored. */
  it('grows a three-cornered preview under the finger, committing nothing yet', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))

    press(result, 20, 20)
    move(result, 50, 20)

    expect(result.current.preview?.type).toBe('zoneTriangle')
    expect(result.current.preview?.points).toHaveLength(6)
    expect(result.current.preview?.points.slice(0, 2)).toEqual([20, 20])
    expect(drawings()).toHaveLength(0)
  })

  /**
   * A press that never travels must leave *nothing* behind — no stray shape and
   * no stranded draft either, which is the half that would otherwise sit there
   * invisibly and be committed by the next unrelated gesture.
   */
  it('leaves nothing behind for a press that never travelled', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode })

    tap(result, 40, 40)

    expect(drawings()).toHaveLength(0)
    expect(result.current.draft).toBeNull()
  })

  it('abandons a triangle under the finger on Escape but keeps the tool armed', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))

    press(result, 10, 10)
    move(result, 40, 40)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('zoneTriangle')
    expect(result.current.draft).toBeNull()
    expect(drawings()).toHaveLength(0)
  })
})

/**
 * The Shape tool, which is two gestures wearing one button.
 *
 * Drag and it traces a free shape, which is what a hand on a phone wants.
 * Tap and it places a corner, which is what a coach wants when the shape has to
 * be exact — that half is what the existing double-tap fix was about and it is
 * not being taken away. What the tests are really for is the seam: the two must
 * never be accumulating into the same shape at the same time, and only the
 * press that opens a shape may choose between them.
 */
describe('useDrawGesture: the Shape tool traces or takes corners', () => {
  const { at, press, move, release, tap, sweep } = gestures()
  const drawings = () => useBoardStore.getState().drawings

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('zonePoly')
  })

  /**
   * Traced at the speed a hand traces, rather than one flushed sample at a time.
   *
   * This is the case a browser found and every other test in this file missed.
   * The Shape tool is the only gesture whose `mode` changes while it is running,
   * and `pointermove` is not discrete, so React batches a burst of them and
   * re-renders once at the end. A handler that picked its branch from the render
   * closure sent every sample after the change to the branch the gesture had
   * already left — the corner branch, which refuses anything longer than two
   * numbers — and dropped them without a sound. On screen: a lasso traced right
   * round and committed as a three-point splinter.
   *
   * So the assertion is about the count, and `sweep` is the whole of the setup.
   */
  it('keeps the samples of a lasso traced faster than React re-renders', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode })

    press(result, 10, 10)
    sweep(result, [
      [12, 10],
      [14, 10],
      [16, 12],
      [16, 14],
      [14, 16],
      [12, 16],
      [10, 14],
    ])
    release(result)

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].type).toBe('zonePoly')
    // The press plus all seven samples: every one is well past `LASSO_STEP`, so
    // none is thinned and none may be lost. Before the fix this was three.
    expect(drawings()[0].points).toHaveLength(16)
  })

  it('commits exactly one closed polygon for a lasso, thinned on the way', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode })

    // A hundred samples tracing a wedge, evenly spaced about 0.54 units apart —
    // which is what a finger dragged for a second or two actually produces, and
    // comfortably under the 0.8 the lasso keeps, so most of them have to be
    // dropped. Two of them together clear it, so every other one survives.
    const moves = 100
    press(result, 10, 10)
    for (let i = 1; i <= moves; i++) {
      const up = i <= moves / 2 ? i : moves - i
      move(result, 10 + i * 0.5, 10 + up * 0.2)
    }
    release(result)

    expect(drawings()).toHaveLength(1)
    // Closing is the renderer's job — `DrawingShape` draws a `zonePoly` as a
    // closed, filled `Line` — so what the data has to carry is the type and the
    // zone fill, and the corners in the order they were traced.
    expect(drawings()[0].type).toBe('zonePoly')
    expect(drawings()[0].fillOpacity).toBeDefined()

    const stored = drawings()[0].points.length / 2
    // Decimation happened at all...
    expect(stored).toBeLessThan(moves + 1)
    // ...and by half rather than by one sample.
    expect(stored).toBeLessThanOrEqual(moves / 2 + 1)
    // ...and still left a shape rather than thinning it to nothing.
    expect(stored).toBeGreaterThanOrEqual(3)
    expect(result.current.draft).toBeNull()
  })

  it('discards a lasso too short to be a shape', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))

    press(result, 10, 10)
    move(result, 14, 10)
    release(result)

    expect(drawings()).toHaveLength(0)
    expect(result.current.draft).toBeNull()
  })

  it('still places a corner on a tap, and still closes on Enter', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode })

    tap(result, 10, 10)
    expect(result.current.draft?.mode).toBe('corners')
    expect(result.current.draft?.points).toEqual([10, 10])

    tap(result, 60, 10)
    tap(result, 60, 50)
    expect(drawings()).toHaveLength(0)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].type).toBe('zonePoly')
    expect(drawings()[0].points).toEqual([10, 10, 60, 10, 60, 50])
    expect(result.current.draft).toBeNull()
  })

  /**
   * The same close, through `commitPoly` directly, which is what the stage's
   * `dblclick` and `dbltap` handlers call — the half of the gesture that works
   * without a keyboard, and the reason the phone fix exists at all.
   */
  it('closes on a double-click as well, with one polygon and not two', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode })

    tap(result, 10, 10)
    tap(result, 60, 10)
    tap(result, 60, 50)
    act(() => {
      result.current.commitPoly()
    })

    expect(drawings()).toHaveLength(1)
  })

  /**
   * A corner is where somebody put it. Once the list has started, a move can
   * neither rubber-band it nor start tracing alongside it — the two modes must
   * never be accumulating into one shape.
   */
  it('neither rubber-bands nor starts tracing once a corner list has begun', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))

    tap(result, 10, 10)
    press(result, 60, 10)
    move(result, 60, 50)
    move(result, 20, 80)

    expect(result.current.draft?.mode).toBe('corners')
    expect(result.current.draft?.points).toEqual([10, 10, 60, 10])
  })

  /**
   * The reason the hook tracks whether the button is down at all: between two
   * placed corners a mouse crosses the whole pitch, and every one of those
   * moves looks exactly like a traced one.
   */
  it('does not start tracing when the pointer merely crosses the pitch', () => {
    const { result } = renderHook(() => useDrawGesture(at, radius))

    tap(result, 10, 10)
    move(result, 90, 90)

    expect(result.current.draft?.mode).toBe('corners')
    expect(result.current.draft?.points).toEqual([10, 10])
  })
})

/**
 * The eraser, which is the one armed tool that ends with less on the board than
 * it started with.
 *
 * It has no draft and makes no preview drawing, so almost everything the other
 * gestures assert has no counterpart here. What is worth holding instead is the
 * shape of the damage it can do: that a hover cannot erase, that a sweep is one
 * undo step rather than one per mark met, and that a sweep across bare grass
 * spends no step at all.
 */
describe('useDrawGesture: the eraser', () => {
  const { at, press, move, release, tap } = gestures()
  const drawings = () => useBoardStore.getState().drawings
  const steps = () => useBoardStore.getState().history.past.length

  /** A short line, well away from the others, so a disc of 3 units meets one at a time. */
  const put = (points: number[]) =>
    useBoardStore
      .getState()
      .addDrawing(createDrawing('line', points, useBoardStore.getState().drawStyle))

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('eraser')
  })

  it('takes a mark on the press, without waiting for a drag', () => {
    const a = put([10, 10, 14, 10])
    put([80, 80, 84, 80])

    tap(result(), 12, 10)

    expect(drawings().map((d) => d.id)).not.toContain(a)
    expect(drawings()).toHaveLength(1)
  })

  it('leaves everything alone on a pointer that is merely passing over', () => {
    put([10, 10, 14, 10])
    const hook = result()

    move(hook, 12, 10)
    move(hook, 12, 11)

    expect(drawings()).toHaveLength(1)
    // ...but the disc has followed, because showing where it would take
    // something is the whole of the warning before something disappears.
    expect(hook.current.eraser).toEqual({ nx: 12, ny: 11, radius: 3 })
  })

  it('sweeps up everything the disc passes over, as one undo step', () => {
    put([10, 10, 14, 10])
    put([40, 10, 44, 10])
    put([70, 10, 74, 10])
    const before = steps()
    const hook = result()

    press(hook, 12, 10)
    move(hook, 42, 10)
    move(hook, 72, 10)
    release(hook)

    expect(drawings()).toHaveLength(0)
    expect(steps()).toBe(before + 1)

    act(() => useBoardStore.getState().undoAction())
    expect(drawings()).toHaveLength(3)
  })

  it('spends no undo step on a sweep across bare grass', () => {
    put([10, 10, 14, 10])
    const before = steps()
    const hook = result()

    press(hook, 60, 60)
    move(hook, 70, 70)
    release(hook)

    expect(drawings()).toHaveLength(1)
    expect(steps()).toBe(before)
  })

  /**
   * The eraser arms the same path a draw tool does — no marquee, no default
   * cursor — while creating none of the things that path was built around. A
   * draft here would be committed as a drawing by the release that ends the
   * sweep.
   */
  it('arms the canvas without a draft or a preview to commit', () => {
    put([10, 10, 14, 10])
    const hook = result()

    press(hook, 12, 10)
    move(hook, 20, 10)

    expect(hook.current.armed).toBe(true)
    expect(hook.current.draft).toBeNull()
    expect(hook.current.preview).toBeNull()
  })

  it('takes its ring away with the tool', () => {
    const hook = result()
    move(hook, 30, 30)
    expect(hook.current.eraser).not.toBeNull()

    act(() => useBoardStore.getState().setTool('select'))

    expect(hook.current.eraser).toBeNull()
  })

  /**
   * It can only take what is on screen, which is the marquee's rule and matters
   * more here.
   *
   * `toNorm` is linear and unclamped, so on a half view the pointer reaches the
   * hidden half's board coordinates just by moving onto the bare canvas beside
   * the pitch — it does not have to leave the window. Without the filter a sweep
   * along that edge silently destroys work nobody in the room can see, and
   * leaves nothing on screen to point at afterwards.
   */
  it('cannot take a mark the half view is hiding', () => {
    act(() => useBoardStore.getState().setView({ view: 'attackHalf' }))
    const hidden = put([10, 10, 14, 10])
    const shown = put([80, 10, 84, 10])
    const hook = result()

    tap(hook, 12, 10)
    expect(drawings().map((d) => d.id)).toContain(hidden)

    tap(hook, 82, 10)
    expect(drawings().map((d) => d.id)).not.toContain(shown)
  })

  /**
   * A release always ends the press, even the ones the canvas is not allowed to
   * act on.
   *
   * `PitchCanvas` calls `onPointerUp` only while the board is unlocked, so an
   * owner taking the floor mid-sweep swallows that member's release. `endPress`
   * runs ahead of that gate; without it the flag stayed set and the next hover
   * after the lock lifted erased whatever it crossed, which is exactly what the
   * flag exists to prevent.
   */
  it('stops erasing on hover after a release the lock swallowed', () => {
    put([40, 10, 44, 10])
    const hook = result()

    press(hook, 80, 80)
    // The lock is taken here, so `onPointerUp` never runs — only `endPress`.
    act(() => hook.current.endPress())
    move(hook, 42, 10)

    expect(drawings()).toHaveLength(1)
  })

  function result() {
    return renderHook(() => useDrawGesture(at, radius), { wrapper: StrictMode }).result
  }
})
