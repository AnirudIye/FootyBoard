import { describe, it, expect, beforeEach } from 'vitest'
import { useBoardStore } from './boardStore'

describe('selection actions', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('duplicate adds offset copies of the selection and selects them', () => {
    const s = useBoardStore.getState()
    const first = s.tokens[0]
    const before = s.tokens.length
    s.setSelection([first.id])
    s.duplicateSelection()

    const after = useBoardStore.getState()
    expect(after.tokens.length).toBe(before + 1)
    expect(after.selection).toHaveLength(1)
    expect(after.selection[0]).not.toBe(first.id)

    const copy = after.tokens.find((t) => t.id === after.selection[0])!
    expect(copy.number).toBe(first.number)
    expect(copy.x).not.toBe(first.x)
  })

  it('delete removes exactly the selection and clears it', () => {
    const s = useBoardStore.getState()
    const ids = s.tokens.slice(0, 3).map((t) => t.id)
    const before = s.tokens.length
    s.setSelection(ids)
    s.deleteSelection()

    const after = useBoardStore.getState()
    expect(after.tokens.length).toBe(before - 3)
    expect(after.selection).toEqual([])
    for (const id of ids) expect(after.tokens.find((t) => t.id === id)).toBeUndefined()
  })

  it('toggleSelection adds then removes an id', () => {
    const s = useBoardStore.getState()
    const id = s.tokens[0].id
    s.toggleSelection(id)
    expect(useBoardStore.getState().selection).toContain(id)
    useBoardStore.getState().toggleSelection(id)
    expect(useBoardStore.getState().selection).not.toContain(id)
  })

  it('a group nudge moves every selected token by the same delta', () => {
    const s = useBoardStore.getState()
    const ids = s.tokens.slice(0, 4).map((t) => t.id)
    const startXs = s.tokens.slice(0, 4).map((t) => t.x)
    s.setSelection(ids)
    s.moveTokens(ids, 5, 0)
    s.commit()

    const after = useBoardStore.getState()
    ids.forEach((id, i) => {
      const t = after.tokens.find((x) => x.id === id)!
      expect(t.x).toBeCloseTo(startXs[i] + 5, 6)
    })
  })

  it('benching moves a player off the pitch and back on again', () => {
    const s = useBoardStore.getState()
    const player = s.tokens.find((t) => t.teamId === 'home' && t.type === 'player')!
    const onPitch = s.tokens.length
    const benched = s.bench.length

    s.benchToken(player.id)
    let after = useBoardStore.getState()
    expect(after.tokens.length).toBe(onPitch - 1)
    expect(after.bench.length).toBe(benched + 1)
    expect(after.bench.some((t) => t.id === player.id)).toBe(true)

    after.unbenchToken(player.id, 30, 40)
    after = useBoardStore.getState()
    expect(after.tokens.length).toBe(onPitch)
    expect(after.bench.length).toBe(benched)
    const back = after.tokens.find((t) => t.id === player.id)!
    expect(back.x).toBeCloseTo(30, 6)
    expect(back.y).toBeCloseTo(40, 6)
  })

  it('bringing a substitute on clamps them inside the pitch', () => {
    const s = useBoardStore.getState()
    const sub = s.bench[0]
    s.unbenchToken(sub.id, 500, -80)
    const back = useBoardStore.getState().tokens.find((t) => t.id === sub.id)!
    expect(back.x).toBeLessThanOrEqual(100)
    expect(back.y).toBeGreaterThanOrEqual(0)
  })

  it('undo restores a deletion', () => {
    const s = useBoardStore.getState()
    const before = s.tokens.length
    s.setSelection([s.tokens[0].id])
    s.deleteSelection()
    useBoardStore.getState().undoAction()
    expect(useBoardStore.getState().tokens.length).toBe(before)
  })
})
