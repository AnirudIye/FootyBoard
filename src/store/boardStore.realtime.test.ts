import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useBoardStore } from './boardStore'
import { registerSinks, clearSinks, isApplyingRemote, runAsRemote } from '../lib/realtime/bridge'
import { createDrawing } from '../lib/drawings'
import type { Op } from '../lib/realtime/protocol'

/**
 * The two invariants that make collaboration survivable:
 *
 *   1. Applying a peer's op emits nothing, or the two clients volley it forever.
 *   2. A peer's op never enters this client's undo stack, or undo starts taking
 *      back other people's work.
 *
 * Everything else about realtime can be wrong and recoverable. These two cannot.
 */

const sent: { op: Op; key?: string }[] = []
const finals: { op: Op; key: string }[] = []
let replacedCount = 0

const opsOfType = (type: string) => sent.filter((s) => s.op.type === type)

beforeEach(() => {
  sent.length = 0
  finals.length = 0
  replacedCount = 0
  registerSinks({
    send: (op, key) => sent.push({ op, key }),
    sendFinal: (op, key) => finals.push({ op, key }),
    sendReplaced: () => {
      replacedCount += 1
    },
  })
  useBoardStore.getState().initDefaultBoard()
  sent.length = 0
})

afterEach(() => clearSinks())

const firstPlayer = () => useBoardStore.getState().tokens.find((t) => t.type === 'player')!

describe('emitting local edits', () => {
  it('broadcasts a move, keyed on the token so a drag coalesces', () => {
    const id = firstPlayer().id
    useBoardStore.getState().moveToken(id, 70, 30)

    expect(sent).toHaveLength(1)
    expect(sent[0].op).toMatchObject({ type: 'patch', entity: 'token', id, patch: { x: 70, y: 30 } })
    expect(sent[0].key).toBe(`token:${id}`)
  })

  it('sends the exact resting position when the gesture ends', () => {
    const id = firstPlayer().id
    useBoardStore.getState().moveToken(id, 70, 30)
    useBoardStore.getState().moveToken(id, 71.5, 31.5)
    useBoardStore.getState().commit()

    // Throttled ops may have dropped the last few positions; the final one is
    // sent past the throttle so peers land on exactly where it was let go.
    expect(finals).toHaveLength(1)
    const op = finals[0].op as Extract<Op, { type: 'bulk' }>
    expect(op.tokens).toEqual([expect.objectContaining({ id, x: 71.5, y: 31.5 })])
  })

  it('does not send a final op when nothing moved', () => {
    useBoardStore.getState().commit()
    expect(finals).toHaveLength(0)
  })

  it('broadcasts resolved values, not the instruction that produced them', () => {
    const id = firstPlayer().id
    useBoardStore.getState().switchPlayerTeam(id)

    // Not "switch teams" — the receiver must not re-run the renumbering and
    // independently choose a different free shirt number.
    const op = sent.at(-1)!.op as Extract<Op, { type: 'patch' }>
    expect(op.type).toBe('patch')
    expect(op.patch).toMatchObject({ teamId: 'away' })
    expect(typeof (op.patch as { number?: number }).number).toBe('number')
  })

  it('asks peers to re-read rather than sending a whole board', () => {
    // Undo, redo, reset and a format change all rewrite everything at once,
    // which is far past what one message may carry.
    const id = firstPlayer().id
    useBoardStore.getState().moveToken(id, 60, 60)
    useBoardStore.getState().commit()

    useBoardStore.getState().undoAction()
    expect(replacedCount).toBe(1)

    useBoardStore.getState().redoAction()
    expect(replacedCount).toBe(2)

    useBoardStore.getState().setPitchKind('7aside')
    expect(replacedCount).toBe(3)

    useBoardStore.getState().resetBoardAction()
    expect(replacedCount).toBe(4)
  })

  it('does not broadcast state that is nobody else’s business', () => {
    useBoardStore.getState().setTool('pen')
    useBoardStore.getState().setZoom(2)
    useBoardStore.getState().setActiveTeam('away')
    useBoardStore.getState().setPlayback({ playing: true })
    useBoardStore.getState().setDrawStyle({ thickness: 8 })
    expect(sent).toHaveLength(0)
  })
})

/**
 * Deferring the *history* push must not defer anything else.
 *
 * `updateToken(..., defer)` holds one snapshot open in `_pending` so a run of
 * keystrokes is one undo step. Ops carry outcomes and the originator is the
 * only client that saves, so both of those still have to happen per keystroke:
 * a peer that only heard the final value would show a stale name for as long as
 * somebody kept typing, and a save that waited on the undo step would lose
 * everything typed before the tab was closed.
 */
describe('an edit that arrives a character at a time', () => {
  it('broadcasts every keystroke, and is still one undo step', () => {
    const id = firstPlayer().id
    for (const label of ['K', 'Ka', 'Kan']) {
      useBoardStore.getState().updateToken(id, { label }, true)
    }

    expect(opsOfType('patch')).toHaveLength(3)
    expect(sent.at(-1)!.op).toMatchObject({
      type: 'patch',
      entity: 'token',
      id,
      patch: { label: 'Kan' },
    })
    // Unthrottled, like every other patch: three keystrokes, three ops.
    expect(sent.every((s) => s.key === undefined)).toBe(true)

    expect(useBoardStore.getState().history.past).toHaveLength(0)
    useBoardStore.getState().commit()
    expect(useBoardStore.getState().history.past).toHaveLength(1)
  })

  it('sends no resting-position op when the run ends, since nothing moved', () => {
    useBoardStore.getState().updateToken(firstPlayer().id, { label: 'K' }, true)
    useBoardStore.getState().commit()
    expect(finals).toHaveLength(0)
  })

  it('still pushes immediately when the caller is not deferring', () => {
    const id = firstPlayer().id
    useBoardStore.getState().updateToken(id, { color: '#123456' })
    useBoardStore.getState().updateToken(id, { rotation: 90 })

    expect(useBoardStore.getState().history.past).toHaveLength(2)
    expect(opsOfType('patch')).toHaveLength(2)
  })
})

/**
 * A label being dragged, which is the same rule from the other end.
 *
 * The reason it is worth its own case rather than trusting the token one: the
 * resting position is the last op here rather than a separate `emitFinal`,
 * because these patches are unthrottled. If they ever start being throttled,
 * peers keep whichever position the throttle happened to let through and
 * nothing corrects it, which is exactly what `commit()`'s bulk op exists to
 * stop for chips.
 */
describe('a label being dragged', () => {
  const style = { color: '#9c3b22', thickness: 2, fillOpacity: 0.2, curve: 'right' as const }

  it('broadcasts every move, ending on where it came to rest, as one undo step', () => {
    const id = useBoardStore
      .getState()
      .addDrawing(createDrawing('text', [20, 30], style, { text: 'PRESS HIGH' }))
    sent.length = 0

    for (const [x, y] of [[26, 34], [31, 38], [35, 41]]) {
      useBoardStore.getState().updateDrawing(id, { points: [x, y] }, true)
    }

    expect(opsOfType('patch')).toHaveLength(3)
    expect(sent.at(-1)!.op).toMatchObject({
      type: 'patch',
      entity: 'drawing',
      id,
      patch: { points: [35, 41] },
    })
    // Unthrottled, which is what makes the last op the resting one.
    expect(sent.every((s) => s.key === undefined)).toBe(true)

    const before = useBoardStore.getState().history.past.length
    useBoardStore.getState().commit()
    expect(useBoardStore.getState().history.past).toHaveLength(before + 1)
    // And no bulk correction, because there is nothing left to correct.
    expect(finals).toHaveLength(0)
  })
})

describe('echo suppression', () => {
  it('emits nothing while applying a peer’s op', () => {
    const id = firstPlayer().id
    useBoardStore.getState().applyRemote({
      type: 'patch',
      entity: 'token',
      id,
      patch: { x: 12, y: 34 },
    })

    expect(useBoardStore.getState().tokens.find((t) => t.id === id)).toMatchObject({ x: 12, y: 34 })
    expect(sent).toHaveLength(0)
    expect(finals).toHaveLength(0)
  })

  it('emits nothing while adopting a peer’s replaced board', () => {
    const data = useBoardStore.getState().getPersistable()
    useBoardStore.getState().adoptRemote(data)
    expect(sent).toHaveLength(0)
    expect(replacedCount).toBe(0)
  })

  it('clears the flag again afterwards, so local edits still broadcast', () => {
    const id = firstPlayer().id
    useBoardStore.getState().applyRemote({ type: 'patch', entity: 'token', id, patch: { x: 1, y: 1 } })
    expect(isApplyingRemote()).toBe(false)

    useBoardStore.getState().moveToken(id, 5, 5)
    expect(sent).toHaveLength(1)
  })

  it('clears the flag even when applying throws', () => {
    // A malformed op must not leave the flag stuck. If it did, this client
    // would go permanently silent — editing normally while nobody sees a thing,
    // and with no error to suggest why.
    expect(() =>
      runAsRemote(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(isApplyingRemote()).toBe(false)

    useBoardStore.getState().moveToken(firstPlayer().id, 9, 9)
    expect(sent).toHaveLength(1)
  })
})

describe('undo isolation', () => {
  it('does not make a peer’s change undoable', () => {
    const id = firstPlayer().id
    const before = useBoardStore.getState().tokens.find((t) => t.id === id)!

    useBoardStore.getState().applyRemote({ type: 'patch', entity: 'token', id, patch: { x: 80, y: 20 } })
    useBoardStore.getState().undoAction()

    // There was nothing of ours to undo, so the peer's change stands.
    expect(useBoardStore.getState().tokens.find((t) => t.id === id)).toMatchObject({ x: 80, y: 20 })
    expect(before.x).not.toBe(80)
  })

  /**
   * Undo is a *shared rewind*, not a private one.
   *
   * History here is a stack of whole-board snapshots, so restoring one takes
   * everything back — including edits a peer made after that snapshot was
   * taken. Making undo affect only your own work would mean storing an inverse
   * per operation and rebasing it over everything since, which is the
   * operational-transform machinery this design deliberately does without.
   *
   * What matters is that it stays *coherent*: undo broadcasts `replaced`, so
   * every peer converges on the rewound board rather than some being left
   * holding a version that no longer exists.
   */
  it('rewinds the whole board, a peer’s changes included, and tells everyone', () => {
    const [mine, theirs] = useBoardStore.getState().tokens.filter((t) => t.type === 'player')

    useBoardStore.getState().moveToken(mine.id, 10, 10)
    useBoardStore.getState().commit()

    useBoardStore.getState().applyRemote({
      type: 'patch',
      entity: 'token',
      id: theirs.id,
      patch: { x: 90, y: 90 },
    })

    useBoardStore.getState().undoAction()

    const after = useBoardStore.getState().tokens
    expect(after.find((t) => t.id === mine.id)).toMatchObject({ x: mine.x, y: mine.y })
    expect(after.find((t) => t.id === theirs.id)).toMatchObject({ x: theirs.x, y: theirs.y })
    expect(replacedCount).toBe(1)
  })
})

describe('with nobody connected', () => {
  it('works exactly the same', () => {
    clearSinks()
    const id = firstPlayer().id
    expect(() => {
      useBoardStore.getState().moveToken(id, 44, 44)
      useBoardStore.getState().commit()
      useBoardStore.getState().undoAction()
    }).not.toThrow()
    expect(sent).toHaveLength(0)
  })
})

describe('remote frame ops', () => {
  it('keeps the playhead inside the sequence when a peer deletes a frame', () => {
    useBoardStore.getState().addFrame()
    useBoardStore.getState().addFrame()
    useBoardStore.getState().setPlayback({ position: 1 })

    const frames = useBoardStore.getState().frames
    useBoardStore.getState().applyRemote({ type: 'remove', entity: 'frame', ids: [frames[1].id] })

    expect(useBoardStore.getState().frames).toHaveLength(1)
    expect(useBoardStore.getState().playback.position).toBe(0)
  })

  it('turns playback off when a peer deletes the last frame', () => {
    useBoardStore.getState().addFrame()
    useBoardStore.getState().setPlayback({ position: 0, playing: true })

    const frames = useBoardStore.getState().frames
    useBoardStore.getState().applyRemote({ type: 'remove', entity: 'frame', ids: [frames[0].id] })

    expect(useBoardStore.getState().playback).toMatchObject({ position: -1, playing: false })
  })
})

describe('selection', () => {
  it('is broadcast so peers can see what someone is working on', () => {
    const id = firstPlayer().id
    useBoardStore.getState().setSelection([id])
    expect(opsOfType('sel')).toHaveLength(1)
    expect(sent.at(-1)!.op).toMatchObject({ type: 'sel', ids: [id] })
  })

  it('is throttled, since it changes with every marquee frame', () => {
    useBoardStore.getState().setSelection([])
    expect(sent.at(-1)!.key).toBe('sel')
  })
})
