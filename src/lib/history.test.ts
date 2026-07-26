import { describe, it, expect } from 'vitest'
import { createHistory, push, undo, redo } from './history'

describe('history', () => {
  it('undo restores the previous snapshot', () => {
    let h = createHistory<number>()
    h = push(h, 1) // remember state 1, now moving to 2
    const u = undo(h, 2)!
    expect(u.present).toBe(1)
  })
  it('redo re-applies an undone snapshot', () => {
    let h = createHistory<number>()
    h = push(h, 1)
    const u = undo(h, 2)!
    const r = redo(u.history, u.present)!
    expect(r.present).toBe(2)
  })
  it('undo on empty history returns null', () => {
    expect(undo(createHistory<number>(), 5)).toBeNull()
  })
  it('caps history depth', () => {
    let h = createHistory<number>()
    for (let i = 0; i < 100; i++) h = push(h, i, 10)
    expect(h.past.length).toBe(10)
  })
})
