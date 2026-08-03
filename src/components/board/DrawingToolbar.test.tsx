import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import DrawingToolbar from './DrawingToolbar'
import { SWATCHES } from './Inspector'
import { useBoardStore } from '../../store/boardStore'
import { createDrawing, curveControl } from '../../lib/drawings'

const homePlayers = () =>
  useBoardStore.getState().tokens.filter((t) => t.type === 'player' && t.teamId === 'home')

describe('DrawingToolbar context slot', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('select')
  })

  it('stays empty when nothing is selected and no tool is armed', () => {
    render(<DrawingToolbar />)
    expect(screen.queryByText('SEL')).toBeNull()
    expect(screen.queryByText('Edit')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('names the one selected player and offers Edit', () => {
    const p = homePlayers()[0]
    useBoardStore.getState().setSelection([p.id])
    render(<DrawingToolbar />)

    expect(screen.getByText('SEL')).toBeInTheDocument()
    expect(screen.getByText(`#${p.number} HOME`)).toBeInTheDocument()
    expect(screen.getByText('Edit')).toBeInTheDocument()
  })

  it('counts a group and drops Edit, which needs one target', () => {
    const ids = homePlayers().slice(0, 4).map((t) => t.id)
    useBoardStore.getState().setSelection(ids)
    render(<DrawingToolbar />)

    expect(screen.getByText('4 PLAYERS')).toBeInTheDocument()
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('recolours every selected player from one swatch', () => {
    const ids = homePlayers().slice(0, 3).map((t) => t.id)
    useBoardStore.getState().setSelection(ids)
    render(<DrawingToolbar />)

    const target = SWATCHES[3]
    fireEvent.click(screen.getByLabelText(`Set colour ${target}`))

    const after = useBoardStore.getState().tokens.filter((t) => ids.includes(t.id))
    expect(after.map((t) => t.color)).toEqual([target, target, target])
  })

  /**
   * The triangle is a zone, and the toolbar is where that has to be visible: a
   * shape with a fill and no way to set it is the same bug as a shape with no
   * fill at all. Arming it rather than selecting one, because arming is the
   * half that has no drawing to read the value off and so is the half that can
   * quietly fail.
   */
  it('offers the fill slider for an armed triangle, as it does for a box', () => {
    render(<DrawingToolbar />)
    expect(screen.queryByText('Fill')).toBeNull()

    act(() => useBoardStore.getState().setTool('zoneTriangle'))

    expect(screen.getByText('Fill')).toBeInTheDocument()
  })

  it('arms the triangle tool from its own button', () => {
    render(<DrawingToolbar />)
    fireEvent.click(screen.getByText('Triangle'))
    expect(useBoardStore.getState().tool).toBe('zoneTriangle')
  })

  it('anchors the inspector to the whole pill, not the pointer or the button', () => {
    const p = homePlayers()[0]
    useBoardStore.getState().setSelection([p.id])
    const { container } = render(<DrawingToolbar />)

    // The button sits inside the pill's padding, so anchoring to the button
    // would still put the panel flush over the launcher.
    const pill = container.querySelector('[data-placement]')!.firstElementChild!
    pill.getBoundingClientRect = () => ({ top: 630, left: 175 }) as DOMRect
    const edit = screen.getByText('Edit')
    edit.getBoundingClientRect = () => ({ left: 420, top: 637 }) as DOMRect
    fireEvent.click(edit)

    // Turning that anchor into a top-left is the Inspector's job, because only
    // it knows how tall the panel came out.
    const inspector = useBoardStore.getState().inspector
    expect(inspector?.tokenId).toBe(p.id)
    expect(inspector?.x).toBe(420)
    expect(inspector?.y).toBe(630)
  })
})

/**
 * What the bar keeps on screen when there is no room for all of it.
 *
 * The hiding is a class rather than a branch, because the desktop layout has to
 * stay byte-identical and `display: contents` is what does that — so these read
 * `hidden`, which is the whole mechanism. jsdom has no layout and no media
 * queries, so what is under test is which controls are marked to be hidden, not
 * the width at which the marking takes effect.
 */
describe('DrawingToolbar primary set', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('select')
  })

  const tool = (label: string) => screen.getByText(label)
  const tucked = (label: string) => tool(label).className.includes('hidden')

  it('keeps a way to stop drawing and the three marks a board is made of', () => {
    render(<DrawingToolbar />)
    for (const label of ['Select', 'Pen', 'Run', 'Pass']) {
      expect(tucked(label)).toBe(false)
    }
  })

  /**
   * The eraser is on the phone bar, and it is the one entry in `PRIMARY` that is
   * not there for making marks.
   *
   * It is wanted at the moment a stroke has just gone wrong, which on a phone is
   * oftener than anywhere else because a fingertip is blunter than a mouse. Two
   * taps and a hunt behind `More` is the wrong price for undoing the wrong one
   * out of nine strokes, which is the case undo does not cover.
   */
  it('keeps the eraser on the bar, where a mis-drawn stroke is likeliest', () => {
    render(<DrawingToolbar />)
    expect(tool('Erase')).toBeInTheDocument()
    expect(tucked('Erase')).toBe(false)
  })

  it('arms the eraser from its own button', () => {
    render(<DrawingToolbar />)
    fireEvent.click(screen.getByText('Erase'))
    expect(useBoardStore.getState().tool).toBe('eraser')
  })

  it('tucks the rest away', () => {
    render(<DrawingToolbar />)
    for (const label of ['Line', 'Bend', 'Bent pass', 'Box', 'Oval', 'Triangle', 'Shape', 'Text']) {
      expect(tucked(label)).toBe(true)
    }
  })

  /**
   * A bar that hides which tool it is in is a bar that draws the wrong thing,
   * and the armed tool moves between the two sets — which is also why the tucked
   * ones are marked one by one rather than wrapped in a `contents` div the way
   * the top bar's groups are. A wrapper would have to render the armed tool in
   * both halves and put two of it on the bar.
   */
  it('never tucks the armed tool away, wherever it belongs', () => {
    act(() => useBoardStore.getState().setTool('zonePoly'))
    render(<DrawingToolbar />)

    expect(tucked('Shape')).toBe(false)
    expect(tucked('Triangle')).toBe(true)
    // And Select is still there, because it is how you put the tool away
    // without an Escape key.
    expect(tucked('Select')).toBe(false)
  })

  it('brings the whole kit back, ink and weight included', () => {
    render(<DrawingToolbar />)
    const toggle = screen.getByLabelText('More drawing tools, ink and weight')
    // The ink group and the slider are inside the wrapper this toggle controls.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)

    expect(screen.getByLabelText('Fewer drawing tools')).toHaveAttribute('aria-expanded', 'true')
    for (const label of ['Line', 'Triangle', 'Shape', 'Text']) {
      expect(tucked(label)).toBe(false)
    }
  })
})

/**
 * Bend, which was being missed.
 *
 * It lived in the floating context pill, and the pill is placed beside the bar
 * or above it depending on a measurement — so the one control a curve tool
 * cannot be used without was the one control that was never twice in the same
 * place. It is now a row inside the bar, directly under the tools, at every
 * width. These cases are about where it is, not about what it does to a curve:
 * that logic is untouched and is asserted at the bottom.
 */
describe('DrawingToolbar bend row', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('select')
    useBoardStore.getState().setDrawStyle({ curve: 'right' })
  })

  const bendRow = () => screen.queryByRole('group', { name: 'Bend direction' })

  it('is absent until a curve is in play', () => {
    render(<DrawingToolbar />)
    expect(bendRow()).toBeNull()
  })

  it('appears when a curve tool is armed', () => {
    const { rerender } = render(<DrawingToolbar />)
    act(() => useBoardStore.getState().setTool('curveArrow'))
    rerender(<DrawingToolbar />)

    expect(bendRow()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'left' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'right' })).toBeInTheDocument()
  })

  it('stays away for a tool that has no bend to it', () => {
    act(() => useBoardStore.getState().setTool('pen'))
    render(<DrawingToolbar />)
    expect(bendRow()).toBeNull()
  })

  /**
   * The whole point of moving it. The bar hides eight of its thirteen tools
   * below `roomy` and brings them back behind `More`; this row is not part of
   * that group and carries none of its classes, so there is no width at which it
   * is a tap away.
   */
  it('is on the bar at every width, never behind the More toggle', () => {
    act(() => useBoardStore.getState().setTool('curveArrow'))
    const { container } = render(<DrawingToolbar />)

    const row = bendRow()!
    expect(row.className).not.toContain('hidden')
    expect(container.querySelector('[aria-expanded]')?.contains(row)).toBe(false)
  })

  /**
   * And it is out of the pill entirely, rather than being drawn in both places.
   * With a curve armed and nothing selected there is now no context pill at all,
   * which is the assertion that fails against the version before this move.
   */
  it('leaves the context pill with nothing to show for an armed curve', () => {
    act(() => useBoardStore.getState().setTool('curveArrow'))
    const { container } = render(<DrawingToolbar />)

    expect(bendRow()).toBeInTheDocument()
    expect(container.querySelector('[data-placement]')).toBeNull()
  })

  it('shows for a selected curve as well as an armed one', () => {
    const id = useBoardStore
      .getState()
      .addDrawing(createDrawing('curveArrow', [10, 10, 50, 10], useBoardStore.getState().drawStyle))
    act(() => useBoardStore.getState().setSelection([id]))
    render(<DrawingToolbar />)

    expect(bendRow()).toBeInTheDocument()
  })

  /**
   * `setCurveSide` is unchanged by the move and this says so from the new place:
   * it re-bends every selected curve now, and becomes the default for the next
   * one drawn.
   */
  it('re-bends the selected curve and keeps the answer for the next one', () => {
    const id = useBoardStore
      .getState()
      .addDrawing(createDrawing('curveArrow', [10, 10, 50, 10], useBoardStore.getState().drawStyle))
    act(() => useBoardStore.getState().setSelection([id]))
    render(<DrawingToolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'left' }))

    const after = useBoardStore.getState()
    expect(after.drawings[0].control).toEqual(curveControl([10, 10, 50, 10], 'left'))
    expect(after.drawStyle.curve).toBe('left')
  })
})

/**
 * The pill is placed against its measured width, and these numbers came from the
 * browser: the tool group was a constant 931.11px, centred inside a rail inset
 * 12px from each edge, and the pill variants that broke a fixed breakpoint were
 * 254px for a selected curve, 378 for curve + zone and 389 for curve + ball —
 * one breakpoint cannot serve them.
 *
 * **Every number here is now a fixture rather than a current measurement, and
 * saying so is cheaper than re-measuring numbers this file only ever feeds back
 * to itself through a stubbed rect.** `BAR` went stale when the Triangle tool
 * widened the group by a button and again when the eraser did. The pill widths
 * went stale when Bend moved out of the pill and into the bar, which took a
 * control out of all three variants above. What is under test is the rule — the
 * pill goes beside the bar exactly when its own width fits in the room left
 * over — and the rule is what survives both. The viewport thresholds asserted
 * below are arithmetic on `BAR` and `PILL`, so a re-measure would move these
 * numbers together rather than falsify any of them.
 *
 * A curve tool is still armed, because the bend row it now puts *inside* the bar
 * must not be part of this arithmetic: it is a second line of the bar, not
 * something competing for the room beside it. The selection is what summons the
 * pill at all now — an armed curve alone leaves it empty.
 */
describe('DrawingToolbar context pill placement', () => {
  const BAR = 931.11
  const PILL = 254

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('curveArrow')
    const id = useBoardStore
      .getState()
      .addDrawing(createDrawing('curveArrow', [10, 10, 50, 10], useBoardStore.getState().drawStyle))
    useBoardStore.getState().setSelection([id])
  })

  const rect = (el: Element, right: number) => {
    el.getBoundingClientRect = () => ({ right }) as DOMRect
  }

  const placementAt = (viewport: number, pillWidth: number) => {
    const { container } = render(<DrawingToolbar />)
    const rail = container.querySelector('aside')!
    const slot = container.querySelector('[data-placement]') as HTMLElement
    rect(rail, viewport - 12)
    rect(rail.firstElementChild!, (viewport + BAR) / 2)
    Object.defineProperty(slot.firstElementChild!, 'offsetWidth', {
      value: pillWidth,
      configurable: true,
    })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    return slot.dataset.placement
  }

  it('takes the row above when a 254px pill would run off a 1366 laptop', () => {
    expect(placementAt(1366, PILL)).toBe('above')
  })

  it('still takes the row above at 1440, where the old breakpoint said side', () => {
    expect(placementAt(1440, PILL)).toBe('above')
  })

  it('sits beside the bar from the width it actually fits, not before', () => {
    expect(placementAt(1487, PILL)).toBe('above')
    expect(placementAt(1488, PILL)).toBe('side')
    expect(placementAt(1920, PILL)).toBe('side')
  })

  it('decides per variant: at 1488 the 254px pill fits beside and the wider ones do not', () => {
    expect(placementAt(1488, PILL)).toBe('side')
    expect(placementAt(1488, 378)).toBe('above')
    expect(placementAt(1488, 389)).toBe('above')
  })

  it('places a narrow pill beside the bar where a wide one cannot go', () => {
    expect(placementAt(1366, 176)).toBe('side')
  })
})
