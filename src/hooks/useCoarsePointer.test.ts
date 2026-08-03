import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCoarsePointer } from './useCoarsePointer'

/**
 * jsdom has no `matchMedia` at all, so the query has to be answered explicitly
 * — the same hole `useTokenTransition`'s tests fill for reduced motion.
 *
 * The fake keeps hold of its listeners, because the one thing here worth
 * asserting is that the answer is allowed to change: a tablet with a trackpad
 * plugged in mid-session must not be left with finger-sized targets, and a
 * hook that only read the query once would leave it with them.
 */
function stubPointer(initial: boolean) {
  let coarse = initial
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return coarse && query.includes('pointer: coarse')
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, fn: () => void) => {
      listeners.add(fn)
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners.delete(fn)
    },
    dispatchEvent: () => false,
  }))
  return {
    listeners,
    change: (next: boolean) =>
      act(() => {
        coarse = next
        for (const fn of listeners) fn()
      }),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('useCoarsePointer', () => {
  it('answers from the query on the very first render', () => {
    stubPointer(true)
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true)
  })

  it('says no for a mouse', () => {
    stubPointer(false)
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false)
  })

  it('follows the device when the pointer changes', () => {
    const device = stubPointer(false)
    const { result } = renderHook(() => useCoarsePointer())

    device.change(true)

    expect(result.current).toBe(true)
  })

  it('lets go of the query when the component goes away', () => {
    const device = stubPointer(false)
    const { unmount } = renderHook(() => useCoarsePointer())
    unmount()

    expect(device.listeners.size).toBe(0)
  })
})
