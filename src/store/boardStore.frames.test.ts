import { describe, it, expect, beforeEach } from 'vitest'
import { useBoardStore } from './boardStore'
import { MAX_FRAMES } from '../lib/frames'

/**
 * The ceiling on a sequence.
 *
 * Everything downstream of the count is linear in it — a chip on the strip, a
 * snapshot of every token in the undo stack and in the saved board, and a
 * longer export — and nothing bounded it. Twenty is 20.9 seconds of movement.
 */
describe('a sequence is bounded', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  const fill = () => {
    for (let i = 0; i < MAX_FRAMES + 5; i++) useBoardStore.getState().addFrame()
  }

  it('stops at the ceiling however many times it is asked', () => {
    fill()
    expect(useBoardStore.getState().frames).toHaveLength(MAX_FRAMES)
  })

  it('refuses rather than dropping the oldest pose', () => {
    // Trimming to make room would silently rewrite a sequence somebody built,
    // and the caller has no way to know. The first frame must still be first.
    const first = (() => {
      useBoardStore.getState().addFrame()
      return useBoardStore.getState().frames[0].id
    })()
    fill()
    expect(useBoardStore.getState().frames[0].id).toBe(first)
  })

  it('does not push an undo step for a capture that did not happen', () => {
    fill()
    const before = useBoardStore.getState().frames.length
    useBoardStore.getState().addFrame()
    useBoardStore.getState().undoAction()
    // One undo takes back the last capture that really landed, not a no-op.
    expect(useBoardStore.getState().frames).toHaveLength(before - 1)
  })

  it('takes another capture once one is deleted', () => {
    fill()
    const { frames, deleteFrame } = useBoardStore.getState()
    deleteFrame(frames[0].id)
    expect(useBoardStore.getState().frames).toHaveLength(MAX_FRAMES - 1)
    useBoardStore.getState().addFrame()
    expect(useBoardStore.getState().frames).toHaveLength(MAX_FRAMES)
  })
})

describe('board frames', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('captures a frame of every token', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    const f = useBoardStore.getState().frames[0]
    expect(Object.keys(f.tokens).length).toBe(s.tokens.length)
  })

  it('captures the positions as they are when added', () => {
    const s = useBoardStore.getState()
    const token = s.tokens[0]
    s.moveToken(token.id, 12, 34)
    s.commit()
    s.addFrame()
    const f = useBoardStore.getState().frames[0]
    expect(f.tokens[token.id].x).toBeCloseTo(12, 5)
    expect(f.tokens[token.id].y).toBeCloseTo(34, 5)
  })

  it('adds and deletes frames, each as one undo step', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    s.addFrame()
    expect(useBoardStore.getState().frames).toHaveLength(2)
    useBoardStore.getState().undoAction()
    expect(useBoardStore.getState().frames).toHaveLength(1)

    const id0 = useBoardStore.getState().frames[0].id
    useBoardStore.getState().deleteFrame(id0)
    expect(useBoardStore.getState().frames).toHaveLength(0)
    useBoardStore.getState().undoAction()
    expect(useBoardStore.getState().frames).toHaveLength(1)
  })

  it('recaptures a frame at the new positions', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    const frameId = useBoardStore.getState().frames[0].id
    const token = useBoardStore.getState().tokens[0]
    useBoardStore.getState().moveToken(token.id, 80, 80)
    useBoardStore.getState().commit()
    useBoardStore.getState().recaptureFrame(frameId)
    expect(useBoardStore.getState().frames[0].tokens[token.id].x).toBeCloseTo(80, 5)
  })

  it('keeps the playhead inside the sequence when a frame is deleted', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    s.addFrame()
    // Park the playhead on the last frame, then delete that frame.
    useBoardStore.getState().setPlayback({ position: 1, playing: false })
    const frames = useBoardStore.getState().frames
    useBoardStore.getState().deleteFrame(frames[1].id)

    const after = useBoardStore.getState()
    expect(after.frames).toHaveLength(1)
    expect(after.playback.position).toBeLessThanOrEqual(after.frames.length - 1)
    // The playhead must still point at a frame that exists.
    expect(after.frames[Math.round(after.playback.position)]).toBeDefined()
  })

  it('returns the playhead to live when the last frame goes', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    useBoardStore.getState().setPlayback({ position: 0, playing: true })
    const only = useBoardStore.getState().frames[0]
    useBoardStore.getState().deleteFrame(only.id)

    const after = useBoardStore.getState()
    expect(after.frames).toHaveLength(0)
    expect(after.playback.position).toBe(-1)
    expect(after.playback.playing).toBe(false)
  })

  it('keeps the playhead valid when undo removes frames', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    s.addFrame()
    useBoardStore.getState().setPlayback({ position: 1, playing: false })
    useBoardStore.getState().undoAction() // back to one frame

    const after = useBoardStore.getState()
    expect(after.frames).toHaveLength(1)
    expect(after.frames[Math.round(after.playback.position)]).toBeDefined()
  })

  it('resets the playhead when the board is reset', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    useBoardStore.getState().setPlayback({ position: 0, playing: true })
    useBoardStore.getState().resetBoardAction()

    const after = useBoardStore.getState()
    expect(after.frames).toHaveLength(0)
    expect(after.playback.position).toBe(-1)
  })

  it('persists frames through a snapshot round trip', () => {
    const s = useBoardStore.getState()
    s.addFrame()
    const snap = useBoardStore.getState().getPersistable()
    useBoardStore.getState().initDefaultBoard()
    expect(useBoardStore.getState().frames).toHaveLength(0)
    useBoardStore.getState().loadPersisted(snap)
    expect(useBoardStore.getState().frames).toHaveLength(1)
  })
})
