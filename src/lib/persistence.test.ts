import { describe, it, expect } from 'vitest'
import { isPersistedBoard, upgradeBoard, SCHEMA_VERSION, MAX_NOTES } from './persistence'
import type { PersistedBoard } from './persistence'
import type { ViewSettings } from './types'
import { useBoardStore, defaultPersistedBoard } from '../store/boardStore'

const view: ViewSettings = {
  view: 'fullH',
  kind: '11',
  grass: true,
  lineColor: '#5ff2d0',
  overlayGrid: false,
  pitchTheme: 'dark',
}

const sample: PersistedBoard = {
  version: SCHEMA_VERSION,
  teams: [],
  tokens: [],
  bench: [],
  drawings: [],
  frames: [],
  view,
  customFormations: [],
  notes: '',
}

/**
 * A row exactly as version 1 wrote it: no `bench`, and a `view` carrying `snap`.
 *
 * Cast rather than typed, because the point of it is that it does not match the
 * current interface — it predates one field and carries one the type no longer
 * has. This is the shape the guard has to accept and the upgrade has to fix.
 */
const storedAtV1 = () =>
  ({
    version: 1,
    teams: [],
    tokens: [],
    drawings: [],
    frames: [],
    view: { ...view, snap: true },
    customFormations: [],
  }) as unknown as PersistedBoard

describe('persistence', () => {
  it('rejects a board that has the right version but the wrong shape', () => {
    // What a truncated or hand-edited server payload looks like.
    expect(isPersistedBoard({ version: SCHEMA_VERSION, hello: 'world' })).toBe(false)
    expect(isPersistedBoard({ ...sample, tokens: undefined })).toBe(false)
    expect(isPersistedBoard({ ...sample, frames: 'nope' })).toBe(false)
    expect(isPersistedBoard({ ...sample, view: null })).toBe(false)
    expect(isPersistedBoard(null)).toBe(false)
    expect(isPersistedBoard('a string')).toBe(false)
    expect(isPersistedBoard(sample)).toBe(true)
  })

  it('rejects a version older than anything it knows how to bring forward', () => {
    // Not "rejects an older version" any more: 1 is older and is accepted. This
    // is about a version with no route to the current one, which is refused
    // rather than loaded and hoped over.
    expect(isPersistedBoard({ ...sample, version: 0 })).toBe(false)
    expect(isPersistedBoard({ ...sample, version: -1 })).toBe(false)
  })

  it('rejects a version that is not a whole number, however board-shaped', () => {
    expect(isPersistedBoard({ ...sample, version: undefined })).toBe(false)
    expect(isPersistedBoard({ ...sample, version: String(SCHEMA_VERSION) })).toBe(false)
    expect(isPersistedBoard({ ...sample, version: 1.5 })).toBe(false)
    expect(isPersistedBoard({ ...sample, version: Number.NaN })).toBe(false)
  })

  it('still loads a board saved before the bench existed', () => {
    const { bench: _bench, ...withoutBench } = sample
    expect(isPersistedBoard(withoutBench)).toBe(true)
  })

  /**
   * The notes cap, which both ends enforce because both ends run this function.
   *
   * Absent has to stay acceptable or every row written before version 4 stops
   * being a board — the guard runs before the migration that fills it in. Over
   * the cap has to be refused, or the limit is a thing the form asks for rather
   * than a thing a stored board has, and the one caller that would notice is the
   * API accepting a write this client could then not open.
   */
  it('accepts a board with no notes, which is every row before version 4', () => {
    const { notes: _notes, ...withoutNotes } = sample
    expect(isPersistedBoard(withoutNotes)).toBe(true)
  })

  it('accepts notes right up to the cap and refuses one character more', () => {
    expect(isPersistedBoard({ ...sample, notes: 'x'.repeat(MAX_NOTES) })).toBe(true)
    expect(isPersistedBoard({ ...sample, notes: 'x'.repeat(MAX_NOTES + 1) })).toBe(false)
  })

  it('refuses notes that are not text', () => {
    expect(isPersistedBoard({ ...sample, notes: 42 })).toBe(false)
    expect(isPersistedBoard({ ...sample, notes: ['a'] })).toBe(false)
    expect(isPersistedBoard({ ...sample, notes: null })).toBe(false)
  })
})

/**
 * A board stored by an older version of this app.
 *
 * This is the one that would have been catastrophic. `isPersistedBoard` compared
 * the version for equality, so the moment `SCHEMA_VERSION` moved, every row
 * already in the database failed the guard and every board went down the "a
 * board that cannot be opened" path — for every user, on load, with nothing
 * having gone wrong. It has happened once already: the bench rails bumped 1 to 2
 * with no migration behind it.
 *
 * So the guard accepts any version this build can bring forward, and the reader
 * brings it forward. The upper bound stays exact for the opposite reason: a
 * board from a *newer* build is one this code cannot know the shape of, and
 * guessing at it is how a client writes a row that loses somebody's work.
 */
describe('a board stored by an older version', () => {
  it('accepts a version 1 row, which a naive version bump would refuse', () => {
    expect(isPersistedBoard(storedAtV1())).toBe(true)
  })

  it('brings it up to the current version', () => {
    const upgraded = upgradeBoard(storedAtV1())

    expect(upgraded.version).toBe(SCHEMA_VERSION)
    // The 1 to 2 step: no substitutes were stored, so the rail is empty. Filled
    // in here rather than left to the reader's default, so what gets written
    // back is a whole current board rather than an old shape with a version
    // number painted on.
    expect(upgraded.bench).toEqual([])
    // The 2 to 3 step. `loadPersisted` clones `view` wholesale, so a field left
    // in the payload would be carried into the store and written straight back
    // out on the next save, for ever.
    expect('snap' in upgraded.view).toBe(false)
    // The 3 to 4 step. An empty pad rather than a missing field, so what is
    // written back is a whole current board: `loadPersisted` would default it
    // either way, and a payload that leans on every future reader remembering to
    // is the half-upgraded board this table exists to avoid.
    expect(upgraded.notes).toBe('')
    // And the rest of the board is untouched.
    expect(upgraded.view.lineColor).toBe(view.lineColor)
  })

  it('leaves notes alone when a board already has them', () => {
    // Idempotence is asserted below on a whole board; this is the field the
    // newest step touches, where a step written as `notes: ''` rather than
    // `notes: board.notes ?? ''` would silently empty the pad of any board that
    // arrives at version 3 carrying one.
    const atV3 = { ...sample, version: 3, notes: 'press high, squeeze the second ball' }
    expect(upgradeBoard(atV3 as never).notes).toBe('press high, squeeze the second ball')
  })

  it('comes out of the upgrade as something both ends accept', () => {
    expect(isPersistedBoard(upgradeBoard(storedAtV1()))).toBe(true)
  })

  it('leaves what it was given alone', () => {
    // The reader hands it a payload straight off the wire and then does other
    // things with the response. A migration that mutated in place would be a
    // second writer of that object.
    const original = storedAtV1()
    upgradeBoard(original)
    expect(original.version).toBe(1)
    expect('snap' in original.view).toBe(true)
  })

  it('is idempotent', () => {
    const once = upgradeBoard(storedAtV1())
    expect(upgradeBoard(once)).toEqual(once)
    expect(upgradeBoard(sample)).toEqual(sample)
  })

  it('refuses a board from a version newer than this build', () => {
    // A client cannot be fed a board from the future: it has no idea what
    // changed, and the honest answer is the same dead end an unparseable payload
    // gets rather than a half-understood board it will then write back.
    expect(isPersistedBoard({ ...sample, version: SCHEMA_VERSION + 1 })).toBe(false)
  })

  it('still refuses every junk shape the dev database collected', () => {
    // Real rows, from when `POST /api/boards` accepted anything. Two of them are
    // at version 1 (`probe board`) and four decrypt to `{"v":1}` (`anon test`,
    // `QA2 unreadable`, `QA2 only-unreadable`), so widening the version check is
    // exactly the change that could have let them in. They are refused on shape,
    // which is the part that has to keep holding.
    for (const junk of [
      { v: 1 },
      { version: 1 },
      { version: 2 },
      { version: 2, tokens: [] },
      { version: SCHEMA_VERSION },
    ]) {
      expect(isPersistedBoard(junk)).toBe(false)
    }
  })
})

/**
 * The guard and the serialiser, held against each other.
 *
 * This stopped being a client-only question. `POST /api/boards` used to accept
 * any payload at all, which is how the dev database collected rows the client
 * then refused to open, so the API now runs this same guard on write: the one
 * in `boardSchema.js`, imported by both ends rather than copied into the second
 * one.
 *
 * That makes the failure mode worth naming, because it points the other way
 * from the bug it fixes. A guard that drifted *stricter* than what the store
 * actually writes would not produce unreadable rows, it would refuse every save
 * the real app makes, for everybody, from the first keystroke. Sharing one
 * function makes the two ends unable to disagree with each other; only this
 * makes them unable to disagree with the board.
 */
describe('what the store writes is what both ends accept', () => {
  it('accepts a fresh board straight out of the store', () => {
    useBoardStore.getState().initDefaultBoard()
    expect(isPersistedBoard(useBoardStore.getState().getPersistable())).toBe(true)
  })

  it('accepts a board with work on it', () => {
    useBoardStore.getState().initDefaultBoard()
    const store = useBoardStore.getState()
    store.addFrame()
    store.moveToken(useBoardStore.getState().tokens[0]!.id, 42, 17)
    store.addDrawing({
      type: 'arrow',
      points: [10, 10, 20, 20],
      color: '#ffffff',
      thickness: 2,
    })

    expect(isPersistedBoard(useBoardStore.getState().getPersistable())).toBe(true)
  })

  it('accepts the payload a brand new account is created with', () => {
    // The one board written by `POST`, rather than by an autosave. It has its
    // own builder, so it is its own way for the two to fall out of step.
    expect(isPersistedBoard(defaultPersistedBoard())).toBe(true)
  })

  it('writes the current version, and nothing an upgrade would still have to fix', () => {
    // What makes the field removal real rather than only declared. The store is
    // the one writer of stored boards, so `snap` surviving here would mean every
    // save put it back and the row never actually stopped carrying it.
    useBoardStore.getState().initDefaultBoard()
    const written = useBoardStore.getState().getPersistable()

    expect(written.version).toBe(SCHEMA_VERSION)
    expect('snap' in written.view).toBe(false)
    expect(upgradeBoard(written)).toEqual(written)
    expect('snap' in defaultPersistedBoard().view).toBe(false)
  })
})
