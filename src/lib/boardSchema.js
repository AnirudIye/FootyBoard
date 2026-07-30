/**
 * What a board payload has to look like, said once for both ends.
 *
 * This is plain JavaScript and not TypeScript for one reason: the API imports
 * it too. The client decides on read whether a stored board is loadable, and the
 * server has to decide on write whether a board is storable, and those are the
 * same question. Answered in two places they drift, and the drift has a
 * direction: a server that accepts what the client refuses writes rows nobody
 * can open again, which is exactly the "That board could not be opened" path and
 * exactly how the junk in the dev database got there.
 *
 * `src/lib/persistence.ts` re-exports all of this with the TypeScript types on
 * them, so nothing in the client imports this file directly and nothing in the
 * client had to move.
 *
 * Note which way the strictness has to point. A guard stricter than the client's
 * own serialiser would refuse writes the real client makes, and breaking saving
 * for everybody is far worse than the rows it would prevent. Sharing the one
 * function is what makes that impossible rather than merely unlikely, and
 * `persistence.test.ts` runs the store's real `getPersistable()` output through
 * it so the serialiser cannot quietly stop satisfying it.
 *
 * The same argument decided the version rule. **What can be upgraded is
 * accepted**, on both ends, because the two ends share this function: the client
 * brings an old row forward on read, and the server takes an old write rather
 * than turning away a bundle that has not been reloaded since a deploy. Only the
 * client upgrades — the server stores what it was given — so an old row stays old
 * until somebody opens it and saves, which is a cost worth paying to keep the API
 * out of the business of rewriting board contents nobody asked it to touch.
 */

export const SCHEMA_VERSION = 3

/**
 * How to bring an older payload forward, one version at a time.
 *
 * Keyed by the version each step upgrades *from*, and each step moves exactly
 * one version, so the set of versions this build accepts is a consequence of
 * what is in this object rather than a second fact stated somewhere else. Add a
 * step and the guard widens; bump `SCHEMA_VERSION` without adding one and the
 * guard narrows, loudly, in the test that opens a version 1 board.
 *
 * Why this exists at all: the guard below used to compare the version for
 * equality, so the moment `SCHEMA_VERSION` moved, every row already in the
 * database stopped being a board and every board went down the "a board that
 * cannot be opened" path — for every user, on load, with nothing having gone
 * wrong. That is not hypothetical. It already happened: the bench rails bumped 1
 * to 2 with no migration behind them, and the only reason nobody lost anything
 * is that the boards which mattered had not been written yet.
 *
 * Each step returns a *whole* payload at the version it names, rather than
 * relying on a reader's defaults to fill the gap. A half-upgraded board is one
 * that leans on every future reader remembering the same thing.
 */
const MIGRATIONS = {
  /**
   * 1 to 2: the bench rails arrived, and boards written before them stored no
   * substitutes at all. An empty rail is what that means.
   */
  1: (board) => ({ ...board, bench: board.bench ?? [], version: 2 }),

  /**
   * 2 to 3: `view.snap` is gone. It held the state of a "Snap to grid" toggle
   * that left the toolbar long ago, and nothing has read the field since; it was
   * still written into every board because the store's default view carried it.
   *
   * Stripped rather than left to rot, and that is the part that makes the removal
   * real: `loadPersisted` clones `view` wholesale, so a field left in the payload
   * would be carried into the store and written straight back out on the next
   * save, for ever, by a build whose types say it does not exist.
   */
  2: (board) => {
    const { snap: _snap, ...view } = board.view
    return { ...board, view, version: 3 }
  },
}

/**
 * Whether this build can carry a payload at `version` up to the current one.
 *
 * The upper bound stays exact, and for the opposite reason to the lower one: a
 * board from a *newer* build is one this code cannot know the shape of. There is
 * nothing to upgrade it with, and a client that opened it anyway would go on to
 * write its own understanding of it back over the row.
 */
function canUpgrade(version) {
  if (!Number.isInteger(version) || version > SCHEMA_VERSION) return false
  for (let v = version; v < SCHEMA_VERSION; v++) if (!MIGRATIONS[v]) return false
  return true
}

/**
 * Whether a payload is actually a board.
 *
 * The version number alone is not enough: board data arrives over the network,
 * and a truncated or hand-edited record can carry the right version with half
 * its arrays missing. That is not a hypothetical either — it is what most of the
 * unopenable rows in the dev database are, and two of them are at version 1, so
 * accepting old versions here had to leave them exactly as refused as they were.
 */
export function isPersistedBoard(value) {
  if (!value || typeof value !== 'object') return false
  if (!canUpgrade(value.version)) return false
  if (!value.view || typeof value.view !== 'object') return false
  return (
    Array.isArray(value.teams) &&
    Array.isArray(value.tokens) &&
    Array.isArray(value.drawings) &&
    Array.isArray(value.frames) &&
    Array.isArray(value.customFormations)
    // `bench` is intentionally not required: boards written before it existed
    // are still loadable, and loadPersisted defaults it to an empty rail. The
    // 1 to 2 migration fills it in for a stored payload, so what still reaches
    // that default is an in-memory snapshot rather than a row.
  )
}

/**
 * The same payload, at the current version.
 *
 * Pure: it returns a new payload and leaves the one it was given alone, because
 * the caller is holding a response it does other things with. Idempotent, so a
 * board already at the current version comes back as it went in, which is what
 * lets the reader run it over everything rather than deciding first.
 *
 * Only ever called on a payload `isPersistedBoard` has accepted — that is what
 * guarantees `view` is an object here, and what stops anything from the future
 * reaching it. It still terminates on a payload it cannot place, by handing back
 * what it was given rather than looping: the guard is the thing that keeps such a
 * payload out, and a hang would be a worse way to find that out than a refusal.
 */
export function upgradeBoard(board) {
  let upgraded = board
  while (upgraded.version < SCHEMA_VERSION && MIGRATIONS[upgraded.version]) {
    upgraded = MIGRATIONS[upgraded.version](upgraded)
  }
  return upgraded
}
