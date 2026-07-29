import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import PitchCanvas from './PitchCanvas'
import { useBoardStore } from '../../store/boardStore'

/**
 * Konva cannot draw in jsdom without the `canvas` package, so the stage itself
 * is out of reach here: the container reports a zero size and the canvas is
 * never created. What is in reach is the wiring, which is the half that was
 * missing. A marquee, a pan and a draw gesture all ended on the stage's own
 * `onPointerUp`, and Konva binds that to `stage.content` alone, so a release
 * over a bench rail, the toolbar or the frame strip never ended them.
 *
 * See `useWindowPointerUp` for the teardown itself, which is asserted there.
 */
describe('PitchCanvas gesture teardown', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    useBoardStore.getState().initDefaultBoard()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('listens for the end of a gesture on the window', () => {
    const on = vi.spyOn(window, 'addEventListener')
    render(<PitchCanvas />)

    const listening = on.mock.calls.map((c) => c[0])
    expect(listening).toContain('pointerup')
    // The browser can take a pointer away without ever releasing it.
    expect(listening).toContain('pointercancel')
  })

  it('lets go of the window when the board closes', () => {
    const { unmount } = render(<PitchCanvas />)
    const off = vi.spyOn(window, 'removeEventListener')
    unmount()

    const released = off.mock.calls.map((c) => c[0])
    expect(released).toContain('pointerup')
    expect(released).toContain('pointercancel')
  })
})
