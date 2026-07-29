import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useWindowPointerUp } from './useWindowPointerUp'

const release = (type: 'pointerup' | 'pointercancel') =>
  window.dispatchEvent(new Event(type))

describe('useWindowPointerUp', () => {
  it('runs the teardown for a release anywhere on the page', () => {
    // A Konva stage only hears a release over its own content, which is why a
    // gesture that ended over a bench rail or the toolbar used to hang.
    const end = vi.fn()
    renderHook(() => useWindowPointerUp(end))

    release('pointerup')

    expect(end).toHaveBeenCalledTimes(1)
  })

  it('runs the teardown when the browser takes the pointer away', () => {
    const end = vi.fn()
    renderHook(() => useWindowPointerUp(end))

    release('pointercancel')

    expect(end).toHaveBeenCalledTimes(1)
  })

  it('runs the current teardown, not the one from the first render', () => {
    // A pen stroke rebuilds the callback on every pointermove, so the one held
    // at registration is stale by the time the stroke ends.
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = renderHook(({ fn }) => useWindowPointerUp(fn), {
      initialProps: { fn: first },
    })
    rerender({ fn: latest })

    release('pointerup')

    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('keeps one listener across re-renders', () => {
    const end = vi.fn()
    const { rerender } = renderHook(({ fn }: { fn: () => void }) => useWindowPointerUp(fn), {
      initialProps: { fn: end as () => void },
    })
    // A fresh closure every render, the way a component gives one.
    for (let i = 0; i < 5; i++) rerender({ fn: () => end() })

    release('pointerup')

    expect(end).toHaveBeenCalledTimes(1)
  })

  it('lets go of the window on unmount', () => {
    const end = vi.fn()
    const { unmount } = renderHook(() => useWindowPointerUp(end))
    unmount()

    release('pointerup')
    release('pointercancel')

    expect(end).not.toHaveBeenCalled()
  })
})
