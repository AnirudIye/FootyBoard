import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, renderHook, fireEvent } from '@testing-library/react'
import { useDrawGesture } from './useDrawGesture'
import { useBoardStore } from '../store/boardStore'

const at = () => ({ x: 50, y: 50 })

describe('useDrawGesture: Escape', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('select')
  })

  it('disarms the tool when no gesture is in progress', () => {
    renderHook(() => useDrawGesture(at))
    act(() => useBoardStore.getState().setTool('pen'))

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('select')
  })

  it('ignores Escape from a text field, which means leave the field', () => {
    renderHook(() => useDrawGesture(at))
    act(() => useBoardStore.getState().setTool('pen'))

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    input.remove()

    expect(useBoardStore.getState().tool).toBe('pen')
  })

  it('abandons a polygon in progress but keeps the tool armed', () => {
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))

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
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))
    const evt = { preventDefault: vi.fn() }

    act(() => {
      result.current.onPointerDown(300, 200, evt)
    })

    expect(evt.preventDefault).not.toHaveBeenCalled()
  })

  it('keeps an empty box standing when it is blurred, rather than discarding it', () => {
    useBoardStore.getState().setTool('text')
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))
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
    const { result } = renderHook(() => useDrawGesture(at))
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
 * Three clicks, one corner each, and the shape closes itself.
 *
 * The triangle was a drag for a few hours: two points of a box, apex derived on
 * the way to the screen. Clicking the corners you actually want is fewer things
 * to know, and it makes the stored shape the corners themselves, which is why
 * the renderer no longer tells a triangle from a polygon.
 */
describe('useDrawGesture: the triangle closes on its third corner', () => {
  let cursor = { x: 0, y: 0 }
  const here = () => cursor

  const clickAt = (result: { current: ReturnType<typeof useDrawGesture> }, x: number, y: number) => {
    cursor = { x, y }
    act(() => {
      result.current.onPointerDown(x, y)
    })
    act(() => {
      result.current.onPointerUp()
    })
  }

  const drawings = () => useBoardStore.getState().drawings

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('zoneTriangle')
    cursor = { x: 0, y: 0 }
  })

  it('adds nothing until the third corner, then exactly one triangle', () => {
    const { result } = renderHook(() => useDrawGesture(here))

    clickAt(result, 10, 10)
    expect(drawings()).toHaveLength(0)

    clickAt(result, 30, 60)
    expect(drawings()).toHaveLength(0)
    expect(result.current.draft?.points).toEqual([10, 10, 30, 60])

    clickAt(result, 70, 20)

    expect(drawings()).toHaveLength(1)
    expect(drawings()[0].type).toBe('zoneTriangle')
    // The three corners as placed, in order. No derivation, nothing normalised.
    expect(drawings()[0].points).toEqual([10, 10, 30, 60, 70, 20])
  })

  /** The gesture ends cleanly, so the next click starts a new shape. */
  it('clears the draft on completion and begins again on the next click', () => {
    const { result } = renderHook(() => useDrawGesture(here))

    clickAt(result, 10, 10)
    clickAt(result, 30, 60)
    clickAt(result, 70, 20)
    expect(result.current.draft).toBeNull()

    clickAt(result, 80, 80)
    expect(result.current.draft?.points).toEqual([80, 80])
    expect(drawings()).toHaveLength(1)
  })

  /**
   * A corner is where somebody put it. Moving between clicks must not drag the
   * previous one around, which is what a drag shape's pointer-move does.
   */
  it('does not rubber-band a placed corner when the pointer moves', () => {
    const { result } = renderHook(() => useDrawGesture(here))

    clickAt(result, 10, 10)
    cursor = { x: 99, y: 99 }
    act(() => {
      result.current.onPointerMove()
    })

    expect(result.current.draft?.points).toEqual([10, 10])
  })

  it('abandons a half-placed triangle on Escape but keeps the tool armed', () => {
    const { result } = renderHook(() => useDrawGesture(here))

    clickAt(result, 10, 10)
    clickAt(result, 30, 60)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('zoneTriangle')
    expect(result.current.draft).toBeNull()
    expect(drawings()).toHaveLength(0)
  })

  /**
   * The reason the commit sits outside the `setDraft` updater rather than inside
   * it, asserted rather than left as a claim in a comment.
   *
   * React may invoke a state updater more than once for a single update, and
   * StrictMode does it deliberately in development. An `addDrawing` inside one
   * would put two triangles on the board for one click, which is the same defect
   * that made a release over the canvas commit a drawing twice.
   */
  it('adds one triangle, not two, under StrictMode double invocation', () => {
    const { result } = renderHook(() => useDrawGesture(here), { wrapper: StrictMode })

    clickAt(result, 10, 10)
    clickAt(result, 30, 60)
    clickAt(result, 70, 20)

    expect(drawings()).toHaveLength(1)
  })
})
