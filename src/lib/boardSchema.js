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
 * `src/lib/persistence.ts` re-exports both of these with the TypeScript types on
 * them, so nothing in the client imports this file directly and nothing in the
 * client had to move.
 *
 * Note which way the strictness has to point. A guard stricter than the client's
 * own serialiser would refuse writes the real client makes, and breaking saving
 * for everybody is far worse than the rows it would prevent. Sharing the one
 * function is what makes that impossible rather than merely unlikely, and
 * `persistence.test.ts` runs the store's real `getPersistable()` output through
 * it so the serialiser cannot quietly stop satisfying it.
 */

export const SCHEMA_VERSION = 2

/**
 * Whether a payload is actually a board.
 *
 * The version number alone is not enough: board data arrives over the network,
 * and a truncated or hand-edited record can carry the right version with half
 * its arrays missing.
 */
export function isPersistedBoard(value) {
  if (!value || typeof value !== 'object') return false
  if (value.version !== SCHEMA_VERSION) return false
  if (!value.view || typeof value.view !== 'object') return false
  return (
    Array.isArray(value.teams) &&
    Array.isArray(value.tokens) &&
    Array.isArray(value.drawings) &&
    Array.isArray(value.frames) &&
    Array.isArray(value.customFormations)
    // `bench` is intentionally not required: boards written before it existed
    // are still loadable, and loadPersisted defaults it to an empty rail.
  )
}
