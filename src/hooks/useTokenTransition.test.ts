import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTokenTransition } from './useTokenTransition'
import type { Token } from '../lib/types'

const tok = (x: number): Token => ({
  id: 'a',
  type: 'player',
  teamId: 'home',
  number: 4,
  color: '#2ae07a',
  x,
  y: 50,
  rotation: 0,
})

/**
 * Renders the hook and records every x it hands back, which is every x the
 * board would have drawn. `rerender` moves the token and bumps the epoch in one
 * commit, which is exactly what `applyFormation` and undo/redo do.
 */
function probe(x: number, epoch = 0) {
  const drawn: number[] = []
  const view = renderHook(
    ({ tokens, epoch }: { tokens: Token[]; epoch: number }) => {
      const at = useTokenTransition(tokens, epoch)
      drawn.push(at.a?.x ?? NaN)
      return at
    },
    { initialProps: { tokens: [tok(x)], epoch } },
  )
  return { drawn, rerender: view.rerender, unmount: view.unmount }
}

/**
 * One sample of the glide. React flushes everything queued inside a single
 * `act` in one render, so watching the travel means letting go and taking it
 * back repeatedly rather than waiting out the whole 0.42s in one call.
 */
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))))

/** Run the glide out past its end, sampling it on the way. */
async function settle() {
  for (let i = 0; i < 20; i++) await tick()
}

/**
 * jsdom here has no `matchMedia` at all, so the hook's own reduced-motion read
 * has to be answered explicitly. `reduce` is the whole point of the last test:
 * the glide must come back for everyone who did not ask for it, and stay away
 * for everyone who did.
 */
function answerReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

beforeEach(() => answerReducedMotion(false))
afterEach(() => vi.unstubAllGlobals())

describe('useTokenTransition', () => {
  it('does not draw the destination on the render the change lands on', async () => {
    // Tokens and the epoch arrive in the same commit, so the render body used to
    // adopt the destination before the effect could capture where the chips had
    // been, and the glide then ran from the destination to the destination.
    const { drawn, rerender } = probe(10)
    expect(drawn).toEqual([10])

    await act(async () => {
      rerender({ tokens: [tok(90)], epoch: 1 })
    })

    expect(drawn[1]).toBe(10)
  })

  it('travels through the space between, and arrives', async () => {
    const { drawn, rerender } = probe(10)
    await act(async () => {
      rerender({ tokens: [tok(90)], epoch: 1 })
    })
    await settle()

    const between = drawn.filter((v) => v > 10 && v < 90)
    expect(between.length).toBeGreaterThan(3)
    // Monotonic, and it ends where the store says it should.
    expect(drawn.at(-1)).toBeCloseTo(90, 4)
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]).toBeGreaterThanOrEqual(drawn[i - 1])
  })

  it('follows the store exactly when the epoch has not moved', async () => {
    const { drawn, rerender } = probe(10)
    await act(async () => {
      rerender({ tokens: [tok(42)], epoch: 0 })
    })

    // An ordinary drag has no glide to protect: the chip belongs under the
    // pointer on the very frame it moves.
    expect(drawn.at(-1)).toBe(42)
  })

  it('teleports under reduced motion, because that is what was asked for', async () => {
    answerReducedMotion(true)
    const { drawn, rerender } = probe(10)

    await act(async () => {
      rerender({ tokens: [tok(90)], epoch: 1 })
    })
    expect(drawn[1]).toBe(90)

    await settle()
    // Nothing travelled: every frame is one end or the other, and it rests at
    // the destination rather than stranded at the start.
    expect(drawn.filter((v) => v > 10 && v < 90)).toEqual([])
    expect(drawn.at(-1)).toBe(90)
  })
})
