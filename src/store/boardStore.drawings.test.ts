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

  /**
   * Dragging a label, which is one gesture and has to be one undo step.
   *
   * The drag writes a new position on every pointer move, so without the
   * deferred history push a single drag spent a handful of the fifty slots and
   * a `structuredClone` of the whole board each time, and undo walked the label
   * back a few pixels at a time. This is `updateToken`'s rule applied to
   * drawings, and the assertions are the same two: one step for the run, and
   * the run really did land where it was dropped.
   */
  describe('moving a label', () => {
    const steps = () => useBoardStore.getState().history.past.length
    const at = () => useBoardStore.getState().drawings[0].points

    const placeLabel = () => {
      const s = useBoardStore.getState()
      return s.addDrawing(createDrawing('text', [20, 30], style, { text: 'PRESS HIGH' }))
    }

    it('spends one undo step for a whole drag, not one per pointer move', () => {
      const id = placeLabel()
      const before = steps()

      for (const [x, y] of [[22, 31], [26, 34], [31, 38], [35, 41]]) {
        useBoardStore.getState().updateDrawing(id, { points: [x, y] }, true)
      }
      expect(steps()).toBe(before)

      useBoardStore.getState().commit()
      expect(steps()).toBe(before + 1)
    })

    it('leaves the label where it was dropped', () => {
      const id = placeLabel()
      useBoardStore.getState().updateDrawing(id, { points: [26, 34] }, true)
      useBoardStore.getState().updateDrawing(id, { points: [35, 41] }, true)
      useBoardStore.getState().commit()

      expect(at()).toEqual([35, 41])
    })

    it('puts it back where it started in one undo', () => {
      const id = placeLabel()
      useBoardStore.getState().updateDrawing(id, { points: [26, 34] }, true)
      useBoardStore.getState().updateDrawing(id, { points: [35, 41] }, true)
      useBoardStore.getState().commit()

      useBoardStore.getState().undoAction()

      expect(at()).toEqual([20, 30])
    })

    /**
     * The other direction, which is the one that would be worse: a style patch
     * has no gesture around it and no `commit()` coming, so if it ever started
     * deferring, its undo step would be pushed by whatever gesture happened
     * next, or never.
     */
    it('still pushes immediately for an ordinary patch', () => {
      const id = placeLabel()
      const before = steps()

      useBoardStore.getState().updateDrawing(id, { color: '#2c5b8a' })

      expect(steps()).toBe(before + 1)
    })
  })

  /**
   * The other half of the same rule, for the eraser: a sweep meets its marks one
   * at a time and has to be one undo step, not one per mark.
   *
   * The asymmetry with a drag is what makes this worth its own case. A drag ends
   * where it began if you undo it; a sweep that pushed a step per mark would put
   * the ink back in the reverse order it was taken, which reads as the undo key
   * being broken rather than as several steps.
   */
  describe('erasing a run of drawings', () => {
    const steps = () => useBoardStore.getState().history.past.length
    const put = () => useBoardStore.getState().addDrawing(createDrawing('pen', [1, 1, 2, 2], style))

    it('spends one undo step for a whole sweep, not one per mark', () => {
      const ids = [put(), put(), put()]
      const before = steps()

      for (const id of ids) useBoardStore.getState().deleteDrawings([id], true)
      expect(useBoardStore.getState().drawings).toHaveLength(0)
      expect(steps()).toBe(before)

      useBoardStore.getState().commit()
      expect(steps()).toBe(before + 1)
    })

    it('brings the whole sweep back in one undo', () => {
      const ids = [put(), put(), put()]
      for (const id of ids) useBoardStore.getState().deleteDrawings([id], true)
      useBoardStore.getState().commit()

      useBoardStore.getState().undoAction()

      expect(useBoardStore.getState().drawings).toHaveLength(3)
    })

    /**
     * The direction that would be worse, exactly as it is for `updateDrawing`:
     * the Delete button in the toolbar has no gesture around it and no `commit()`
     * coming, so a deferred step there would be pushed by whatever happened next,
     * or never.
     */
    it('still pushes immediately when the caller is not sweeping', () => {
      const id = put()
      const before = steps()

      useBoardStore.getState().deleteDrawings([id])

      expect(steps()).toBe(before + 1)
    })

    /**
     * A sweep across empty grass calls this on every pointer move. Parking a
     * snapshot for one of those would let the release commit an undo step in
     * which nothing at all changed.
     */
    it('parks nothing for a sweep that found nothing', () => {
      put()
      const before = steps()

      useBoardStore.getState().deleteDrawings([], true)
      useBoardStore.getState().commit()

      expect(steps()).toBe(before)
    })
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
