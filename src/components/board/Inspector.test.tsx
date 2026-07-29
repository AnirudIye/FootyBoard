import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Inspector from './Inspector'
import { useBoardStore } from '../../store/boardStore'

// jsdom has no layout, so the panel measures 0 unless it is told otherwise.
// 380 is what the player panel comes out at in a browser, which is the number
// that matters: it is 60px taller than the 320 the launcher used to assume,
// and those 60px are what covered the button that opened it.
const PANEL_H = 380
const PANEL_W = 236

const firstPlayer = () => useBoardStore.getState().tokens.find((t) => t.type === 'player')!

const panelOf = (container: HTMLElement) => container.firstElementChild as HTMLElement

describe('Inspector placement', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => PANEL_H,
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => PANEL_W,
    })
  })

  afterEach(() => {
    // @ts-expect-error restoring jsdom's own zero-height getters
    delete HTMLElement.prototype.offsetHeight
    // @ts-expect-error same
    delete HTMLElement.prototype.offsetWidth
  })

  it('opens below the anchor when the panel fits there', () => {
    useBoardStore.getState().openInspector(firstPlayer().id, 400, 100)
    const { container } = render(<Inspector />)

    expect(panelOf(container).style.top).toBe('100px')
    expect(panelOf(container).style.left).toBe('400px')
  })

  it('flips above the anchor rather than over the pill that opened it', () => {
    // Where the bottom bar's context pill starts at 1280x800.
    useBoardStore.getState().openInspector(firstPlayer().id, 400, 630)
    const { container } = render(<Inspector />)

    const top = Number.parseFloat(panelOf(container).style.top)
    expect(top).toBe(630 - PANEL_H - 8)
    expect(top + PANEL_H).toBeLessThan(630)
  })

  it('keeps the panel on screen at either edge', () => {
    useBoardStore.getState().openInspector(firstPlayer().id, 9999, 4)
    const { container } = render(<Inspector />)

    expect(Number.parseFloat(panelOf(container).style.left)).toBe(
      window.innerWidth - PANEL_W - 8,
    )
    expect(Number.parseFloat(panelOf(container).style.top)).toBeGreaterThanOrEqual(8)
  })
})

/**
 * Typing is a gesture, and a gesture is one undo step.
 *
 * Both fields used to push a whole-board snapshot per `onChange`, so renaming a
 * player spent one of the fifty history slots and one `structuredClone` of the
 * entire board per character, and undo then walked the rename back one letter
 * at a time. They are held in `_pending` now and closed by `commit` on blur,
 * which is how a drag has always worked.
 *
 * The number field had a second bug in the same two lines: `Number('')` is 0,
 * so clearing it put a 0 on the chip, sent that to the room and saved it, past
 * a `min` that React does not enforce.
 */
describe('Inspector edits', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
  })

  const openPanel = () => {
    const player = firstPlayer()
    useBoardStore.getState().openInspector(player.id, 400, 100)
    render(<Inspector />)
    return player
  }

  const tokenNow = (id: string) => useBoardStore.getState().tokens.find((t) => t.id === id)!
  const undoSteps = () => useBoardStore.getState().history.past.length

  it('makes a typed name one undo step rather than one per character', async () => {
    const player = openPanel()

    await userEvent.type(screen.getByLabelText('Name'), 'Kante')
    expect(tokenNow(player.id).label).toBe('Kante')
    // Five characters in, nothing has been pushed: the run is still open.
    expect(undoSteps()).toBe(0)

    // Blur closes it, exactly as letting go closes a drag.
    await userEvent.tab()
    expect(undoSteps()).toBe(1)

    // And one undo takes back the rename, not its last letter.
    act(() => useBoardStore.getState().undoAction())
    expect(tokenNow(player.id).label).toBeUndefined()
  })

  it('treats an empty number field as "leave the number alone"', () => {
    const player = openPanel()
    const number = screen.getByLabelText('Number')

    fireEvent.change(number, { target: { value: '7' } })
    expect(tokenNow(player.id).number).toBe(7)

    fireEvent.change(number, { target: { value: '' } })
    expect(tokenNow(player.id).number).toBe(7)
  })

  it('holds the number inside the range the field advertises', () => {
    const player = openPanel()
    const number = screen.getByLabelText('Number')

    fireEvent.change(number, { target: { value: '7' } })
    fireEvent.change(number, { target: { value: '0' } })
    expect(tokenNow(player.id).number).toBe(1)

    fireEvent.change(number, { target: { value: '250' } })
    expect(tokenNow(player.id).number).toBe(99)
  })

  it('makes a retyped number one undo step as well', async () => {
    const player = openPanel()
    const number = screen.getByLabelText('Number')
    await userEvent.click(number)

    fireEvent.change(number, { target: { value: '1' } })
    fireEvent.change(number, { target: { value: '10' } })
    fireEvent.change(number, { target: { value: '11' } })
    expect(undoSteps()).toBe(0)

    await userEvent.tab()
    expect(undoSteps()).toBe(1)

    act(() => useBoardStore.getState().undoAction())
    expect(tokenNow(player.id).number).toBe(player.number)
  })

  it('closes an open run when the panel goes away without a blur', () => {
    // Escape and the chip being deleted both take the panel down with nothing
    // blurring the input, and a run left open is a rename the next edit's
    // snapshot quietly swallows.
    const player = openPanel()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kante' } })
    expect(undoSteps()).toBe(0)

    act(() => useBoardStore.getState().closeInspector())
    expect(undoSteps()).toBe(1)

    act(() => useBoardStore.getState().undoAction())
    expect(tokenNow(player.id).label).toBeUndefined()
  })
})
