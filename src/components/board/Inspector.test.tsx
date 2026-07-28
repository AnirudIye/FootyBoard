import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
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
