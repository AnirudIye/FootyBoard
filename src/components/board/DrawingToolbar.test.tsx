import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import DrawingToolbar from './DrawingToolbar'
import { SWATCHES } from './Inspector'
import { useBoardStore } from '../../store/boardStore'

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
 * The pill is placed against its measured width, so these are the real numbers,
 * taken from the browser at these viewports: the tool group was a constant
 * 931.11px, centred inside a rail inset 12px from each edge, and a selected
 * curve stacks Bend + left/right + Delete at 254px. Curve + zone is 378 and
 * curve + ball is 389, which is the point: one breakpoint cannot serve them.
 *
 * `BAR` is now a fixture rather than a current measurement — the Triangle tool
 * widened the group by a button — and saying so is cheaper than re-measuring a
 * number this file only feeds back to itself through a stubbed rect. What is
 * under test is the rule, that the pill goes beside the bar exactly when its
 * own width fits in the room left over, and that rule is what survives the
 * group changing width. **The pill widths above are still live**: they measure
 * the context pill, which no tool button is part of, and the viewport
 * thresholds asserted below are arithmetic on `BAR`, so a real re-measure would
 * move the numbers in these tests together rather than falsify any of them.
 */
describe('DrawingToolbar context pill placement', () => {
  const BAR = 931.11
  const CURVE_PILL = 254

  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('curveArrow')
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

  it('takes the row above when a curve pill would run off a 1366 laptop', () => {
    expect(placementAt(1366, CURVE_PILL)).toBe('above')
  })

  it('still takes the row above at 1440, where the old breakpoint said side', () => {
    expect(placementAt(1440, CURVE_PILL)).toBe('above')
  })

  it('sits beside the bar from the width it actually fits, not before', () => {
    expect(placementAt(1487, CURVE_PILL)).toBe('above')
    expect(placementAt(1488, CURVE_PILL)).toBe('side')
    expect(placementAt(1920, CURVE_PILL)).toBe('side')
  })

  it('decides per variant: at 1488 the curve pill fits beside and the wider ones do not', () => {
    expect(placementAt(1488, CURVE_PILL)).toBe('side')
    expect(placementAt(1488, 378)).toBe('above')
    expect(placementAt(1488, 389)).toBe('above')
  })

  it('places a narrow pill beside the bar where a wide one cannot go', () => {
    expect(placementAt(1366, 176)).toBe('side')
  })
})
