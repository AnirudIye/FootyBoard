import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useBoardStore } from './boardStore'
import { registerSinks, clearSinks } from '../lib/realtime/bridge'
import { MAX_NOTES, isPersistedBoard } from '../lib/persistence'
import { MAX_OP_BYTES } from '../lib/realtime/protocol'
import type { Op } from '../lib/realtime/protocol'

/**
 * The notes pad, as the board holds it.
 *
 * Three properties are the whole of what this has to get right, and each of them
 * has a way of being wrong that looks like nothing at all until somebody loses a
 * paragraph:
 *
 *   1. **The cap is the store's, not the field's.** `maxLength` on a
 *      `<textarea>` stops typing and says nothing about a paste — and a board
 *      over the cap is one `isPersistedBoard` refuses, so the symptom is not a
 *      long note, it is a board that quietly stops saving.
 *   2. **Typing is one undo step**, the way a drag is, or a paragraph spends all
 *      fifty history slots and undo walks it back letter by letter.
 *   3. **The room hears about it.** Every client writes the *whole* board, so a
 *      note that never reaches a peer is a note that peer's next autosave
 *      overwrites — silently, with no conflict and nothing to re-read.
 */

const sent: { op: Op; key?: string }[] = []
let replacedCount = 0

beforeEach(() => {
  sent.length = 0
  replacedCount = 0
  registerSinks({
    send: (op, key) => sent.push({ op, key }),
    sendFinal: () => {},
    sendReplaced: () => {
      replacedCount += 1
    },
  })
  useBoardStore.getState().initDefaultBoard()
  sent.length = 0
})

afterEach(() => clearSinks())

const notesOps = () => sent.filter((s) => s.op.type === 'notes')
const steps = () => useBoardStore.getState().history.past.length

describe('the notes pad', () => {
  it('starts empty and is written into the board payload', () => {
    expect(useBoardStore.getState().notes).toBe('')
    useBoardStore.getState().setNotes('Press high, squeeze the second ball')
    expect(useBoardStore.getState().getPersistable().notes).toBe(
      'Press high, squeeze the second ball',
    )
  })

  it('clamps to the cap rather than letting the board become unsavable', () => {
    // A paste, which is the case `maxLength` does not cover.
    useBoardStore.getState().setNotes('x'.repeat(MAX_NOTES + 500))

    const board = useBoardStore.getState().getPersistable()
    expect(board.notes).toHaveLength(MAX_NOTES)
    expect(isPersistedBoard(board)).toBe(true)
  })

  it('spends one undo step for a whole run of typing, not one per keystroke', () => {
    const before = steps()
    for (const text of ['P', 'Pr', 'Pre', 'Press']) {
      useBoardStore.getState().setNotes(text, true)
    }
    expect(steps()).toBe(before)

    useBoardStore.getState().commit()
    expect(steps()).toBe(before + 1)
  })

  it('undoes the whole run back to what was there before it', () => {
    useBoardStore.getState().setNotes('First draft')
    for (const text of ['First draft!', 'First draft!!']) {
      useBoardStore.getState().setNotes(text, true)
    }
    useBoardStore.getState().commit()

    useBoardStore.getState().undoAction()
    expect(useBoardStore.getState().notes).toBe('First draft')
  })

  it('says nothing and spends nothing when the text has not changed', () => {
    // A `<textarea>` fires `change` for a keystroke that inserts nothing —
    // pressing a dead key, or hitting the `maxLength` ceiling and typing on.
    // Left unguarded each one is a message to the room and, undeferred, an undo
    // step in which nothing happened.
    useBoardStore.getState().setNotes('Same')
    const before = steps()
    sent.length = 0

    useBoardStore.getState().setNotes('Same')
    expect(notesOps()).toHaveLength(0)
    expect(steps()).toBe(before)
  })

  it('broadcasts the whole pad, keyed so a run of typing coalesces', () => {
    useBoardStore.getState().setNotes('Mid block', true)

    expect(notesOps()).toHaveLength(1)
    expect(notesOps()[0].op).toEqual({ type: 'notes', text: 'Mid block' })
    // The key is what makes this one message per throttle interval rather than
    // one per character. `cursor` and `sel` are keyed for the same reason.
    expect(notesOps()[0].key).toBe('notes')
  })

  it('is cleared by a reset, which is what the reset panel now promises', () => {
    useBoardStore.getState().setNotes('Team talk')
    useBoardStore.getState().resetBoardAction()
    expect(useBoardStore.getState().notes).toBe('')
  })

  it('takes on a peer’s notes without entering this client’s history', () => {
    const before = steps()
    useBoardStore.getState().applyRemote({ type: 'notes', text: 'From the other bench' })

    expect(useBoardStore.getState().notes).toBe('From the other bench')
    expect(steps()).toBe(before)
    // And nothing echoed back, or the two clients volley it forever.
    expect(notesOps()).toHaveLength(0)
  })
})

/**
 * A note too long to fit in a message.
 *
 * `MAX_NOTES` is 2000 characters and `MAX_OP_BYTES` is 5000 bytes, so any script
 * that encodes to three bytes a character — CJK, most of Indic — can write a
 * perfectly legal note that no op can carry. The socket drops an oversized op
 * *silently*: `write` warns in dev and returns. What that would cost is not the
 * peers being a beat behind, it is the next peer to autosave writing their own
 * older notes over these, with no conflict to catch it, because every client
 * saves the whole board.
 *
 * So the fallback is the one this repo already uses for a change too large to
 * send — write it and tell the room to re-read — and it fires on `commit`
 * rather than per keystroke, or it would be a save and a room-wide re-read per
 * character typed.
 */
describe('a note too long to send as an op', () => {
  // Three bytes each in UTF-8, one UTF-16 code unit each, so 1700 of them are
  // 1700 characters against the cap and 5100 bytes against the op limit.
  const long = '布'.repeat(1700)

  it('is genuinely over the message limit and under the character cap', () => {
    expect(long.length).toBeLessThanOrEqual(MAX_NOTES)
    expect(new TextEncoder().encode(JSON.stringify({ type: 'notes', text: long })).length)
      .toBeGreaterThan(MAX_OP_BYTES)
  })

  it('is not sent as an op, and the room is told to re-read instead', () => {
    useBoardStore.getState().setNotes(long, true)
    expect(notesOps()).toHaveLength(0)
    // Not yet: one of these per keystroke would be a PUT per character.
    expect(replacedCount).toBe(0)

    useBoardStore.getState().commit()
    expect(replacedCount).toBe(1)
  })

  it('announces it once, not on every later gesture', () => {
    useBoardStore.getState().setNotes(long, true)
    useBoardStore.getState().commit()
    expect(replacedCount).toBe(1)

    // An unrelated drag afterwards must not re-announce a note that has already
    // been published, or every gesture on a board with long notes costs the
    // whole room a re-read.
    const player = useBoardStore.getState().tokens.find((t) => t.type === 'player')!
    useBoardStore.getState().moveToken(player.id, 70, 30)
    useBoardStore.getState().commit()
    expect(replacedCount).toBe(1)
  })

  it('is dropped when the board it described is no longer the one open', () => {
    // The flag says "these notes are waiting to be announced". Open another
    // board without blurring the pad and they are not this store's contents any
    // more, so the next `commit()` — a drag on the *new* board — would answer
    // them with a save and a room-wide re-read nobody asked for.
    useBoardStore.getState().setNotes(long, true)
    useBoardStore.getState().initDefaultBoard('another-board')

    useBoardStore.getState().commit()
    expect(replacedCount).toBe(0)
  })

  it('still fires when the run of typing left no undo step of its own', () => {
    // `commit` returns early when `_pending` is empty, so the flag has to be
    // answered in front of that guard: a paste into a pad whose step was already
    // parked by an earlier keystroke is exactly this shape, and behind the guard
    // it would publish for some oversized notes and not others.
    useBoardStore.getState().setNotes(long)
    expect(useBoardStore.getState()._pending).toBe(null)

    useBoardStore.getState().commit()
    expect(replacedCount).toBe(1)
  })
})
