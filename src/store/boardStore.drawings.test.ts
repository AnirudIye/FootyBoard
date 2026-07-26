import { describe, it, expect, beforeEach } from 'vitest'
import { useBoardStore } from './boardStore'
import { createDrawing } from '../lib/drawings'

const style = { color: '#9c3b22', thickness: 2, fillOpacity: 0.2, curve: 'right' as const }

describe('board drawings', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('adds a drawing and undoes it as one step', () => {
    const s = useBoardStore.getState()
    s.addDrawing(createDrawing('arrow', [10, 10, 40, 40], style))
    expect(useBoardStore.getState().drawings).toHaveLength(1)
    useBoardStore.getState().undoAction()
    expect(useBoardStore.getState().drawings).toHaveLength(0)
  })

  it('edits a drawing after the fact', () => {
    const s = useBoardStore.getState()
    const drawingId = s.addDrawing(createDrawing('zoneRect', [10, 10, 40, 40], style))
    useBoardStore.getState().updateDrawing(drawingId, { color: '#2c5b8a', thickness: 5 })
    const d = useBoardStore.getState().drawings[0]
    expect(d.color).toBe('#2c5b8a')
    expect(d.thickness).toBe(5)
  })

  it('deletes a mixed selection of chips and annotations', () => {
    const s = useBoardStore.getState()
    const drawingId = s.addDrawing(createDrawing('pen', [1, 1, 2, 2], style))
    const st = useBoardStore.getState()
    const tokenId = st.tokens[0].id
    const tokenCount = st.tokens.length

    st.setSelection([tokenId, drawingId])
    st.deleteSelection()

    const after = useBoardStore.getState()
    expect(after.tokens.length).toBe(tokenCount - 1)
    expect(after.drawings).toHaveLength(0)
    expect(after.selection).toEqual([])
  })

  it('carries an attached arrow when its player is dragged', () => {
    const s = useBoardStore.getState()
    const token = s.tokens.find((t) => t.type === 'player')!
    const drawingId = s.addDrawing({
      ...createDrawing('arrow', [token.x, token.y, token.x + 10, token.y], style),
      attachedTokenId: token.id,
    })

    useBoardStore.getState().moveToken(token.id, token.x + 5, token.y + 3)
    useBoardStore.getState().commit()

    const d = useBoardStore.getState().drawings.find((x) => x.id === drawingId)!
    expect(d.points[0]).toBeCloseTo(token.x + 5, 5)
    expect(d.points[1]).toBeCloseTo(token.y + 3, 5)
    expect(d.points[2]).toBeCloseTo(token.x + 15, 5)
  })

  it('leaves unattached annotations where they are', () => {
    const s = useBoardStore.getState()
    const token = s.tokens.find((t) => t.type === 'player')!
    const drawingId = s.addDrawing(createDrawing('arrow', [50, 50, 60, 60], style))

    useBoardStore.getState().moveToken(token.id, token.x + 8, token.y)
    useBoardStore.getState().commit()

    const d = useBoardStore.getState().drawings.find((x) => x.id === drawingId)!
    expect(d.points).toEqual([50, 50, 60, 60])
  })

  it('detaches annotations whose player was deleted', () => {
    const s = useBoardStore.getState()
    const token = s.tokens.find((t) => t.type === 'player')!
    const drawingId = s.addDrawing({
      ...createDrawing('arrow', [10, 10, 20, 20], style),
      attachedTokenId: token.id,
    })

    const st = useBoardStore.getState()
    st.setSelection([token.id])
    st.deleteSelection()

    const d = useBoardStore.getState().drawings.find((x) => x.id === drawingId)!
    expect(d.attachedTokenId).toBeUndefined()
  })

  it('keeps the active draw style for the next drawing', () => {
    useBoardStore.getState().setDrawStyle({ color: '#2c5b8a', thickness: 6 })
    const ds = useBoardStore.getState().drawStyle
    expect(ds.color).toBe('#2c5b8a')
    expect(ds.thickness).toBe(6)
    expect(ds.fillOpacity).toBeCloseTo(0.18, 5)
  })

  it('persists drawings through a snapshot round trip', () => {
    const s = useBoardStore.getState()
    s.addDrawing(createDrawing('zoneEllipse', [20, 20, 50, 50], style))
    const snap = useBoardStore.getState().getPersistable()
    useBoardStore.getState().initDefaultBoard()
    expect(useBoardStore.getState().drawings).toHaveLength(0)
    useBoardStore.getState().loadPersisted(snap)
    expect(useBoardStore.getState().drawings).toHaveLength(1)
  })
})
