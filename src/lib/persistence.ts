import type {
  Team,
  Token,
  Drawing,
  Frame,
  ViewSettings,
  CustomFormation,
} from './types'

import {
  SCHEMA_VERSION,
  isPersistedBoard as isBoard,
  upgradeBoard as upgrade,
} from './boardSchema.js'

export { SCHEMA_VERSION }

export interface PersistedBoard {
  version: number
  teams: Team[]
  tokens: Token[]
  /** Substitutes, held off the pitch on the bench rails. */
  bench: Token[]
  drawings: Drawing[]
  frames: Frame[]
  view: ViewSettings
  customFormations: CustomFormation[]
}

/**
 * Whether a payload is actually a board we can load.
 *
 * Checking the shape here means a bad board falls back to a fresh one instead of
 * crashing the app on load. This is all that survives of the old localStorage
 * path: boards live on the server now, so the only thing worth keeping is the
 * guard that decides whether what came back is loadable.
 *
 * The check itself lives in `boardSchema.js`, because the API imports it too.
 * "Is this loadable?" on read and "is this storable?" on write are the same
 * question, and a server that accepted what this refuses would go on writing
 * rows the client cannot open. This wrapper exists only to put the type
 * predicate back on it, which is the one thing a plain JavaScript module cannot
 * carry across.
 */
export function isPersistedBoard(value: unknown): value is PersistedBoard {
  return isBoard(value)
}

/**
 * The same board, at the version this build understands.
 *
 * The guard accepts any version the migrations in `boardSchema.js` can carry
 * forward, so something has to actually carry it, and this is it. See
 * `loadBoard`, which is the one caller: it runs after the read has been accepted,
 * so a board this client is refusing to write to is never upgraded into the
 * store.
 *
 * Types, honestly: `boardSchema.js` is plain JavaScript, so this signature is an
 * assertion rather than a check, exactly like the predicate above. And the input
 * is a `PersistedBoard` only in the loose sense the guard means it — an older
 * payload can be missing `bench` and can carry a `view` field this version has
 * dropped, neither of which the interface describes. That is the whole reason
 * there is something to upgrade.
 */
export function upgradeBoard(board: PersistedBoard): PersistedBoard {
  return upgrade(board)
}
