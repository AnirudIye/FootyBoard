import { describe, it, expect, beforeEach } from 'vitest'
import { useBoardStore } from './boardStore'

const reset = () => useBoardStore.getState().initDefaultBoard()

describe('boardStore', () => {
  beforeEach(() => reset())

  it('creates 22 player chips and a ball by default', () => {
    const t = useBoardStore.getState().tokens
    expect(t.filter((x) => x.type === 'player')).toHaveLength(22)
    expect(t.filter((x) => x.type === 'ball')).toHaveLength(1)
  })

  it('applyFormation repositions the target team and keeps the keeper deepest', () => {
    useBoardStore.getState().applyFormation('home', '4-4-2', 'default')
    const home = useBoardStore.getState().tokens.filter((x) => x.teamId === 'home')
    expect(home).toHaveLength(11)
    const gk = home.find((x) => x.shape === 'keeper')!
    const outfieldMinX = Math.min(...home.filter((x) => x.shape !== 'keeper').map((x) => x.x))
    expect(gk.x).toBeLessThan(outfieldMinX)
  })

  it('undo reverts a formation change', () => {
    const before = JSON.stringify(useBoardStore.getState().getPersistable().tokens)
    useBoardStore.getState().applyFormation('home', '3-5-2', 'high')
    useBoardStore.getState().undoAction()
    const after = JSON.stringify(useBoardStore.getState().getPersistable().tokens)
    expect(after).toBe(before)
  })

  it('moveTokens clamps to bounds', () => {
    const s = useBoardStore.getState()
    const first = s.tokens[0]
    s.moveTokens([first.id], -1000, -1000)
    s.commit()
    const moved = useBoardStore.getState().tokens.find((x) => x.id === first.id)!
    expect(moved.x).toBeGreaterThanOrEqual(0)
    expect(moved.y).toBeGreaterThanOrEqual(0)
  })
})
