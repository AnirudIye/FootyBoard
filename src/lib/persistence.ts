import type {
  Team,
  Token,
  Drawing,
  Frame,
  ViewSettings,
  CustomFormation,
} from './types'

export const SCHEMA_VERSION = 2

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
 * The version number alone is not enough: board data arrives over the network,
 * and a truncated or hand-edited record can carry the right version with half
 * its arrays missing. Checking the shape here means a bad board falls back to a
 * fresh one instead of crashing the app on load.
 *
 * This is all that survives of the old localStorage path. Boards live on the
 * server now, so the only thing worth keeping is the guard that decides whether
 * what came back is loadable.
 */
export function isPersistedBoard(value: unknown): value is PersistedBoard {
  if (!value || typeof value !== 'object') return false
  const board = value as Partial<PersistedBoard>
  if (board.version !== SCHEMA_VERSION) return false
  if (!board.view || typeof board.view !== 'object') return false
  return (
    Array.isArray(board.teams) &&
    Array.isArray(board.tokens) &&
    Array.isArray(board.drawings) &&
    Array.isArray(board.frames) &&
    Array.isArray(board.customFormations)
    // `bench` is intentionally not required: boards written before it existed
    // are still loadable, and loadPersisted defaults it to an empty rail.
  )
}
