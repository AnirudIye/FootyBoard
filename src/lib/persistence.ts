import type {
  Team,
  Token,
  Drawing,
  Frame,
  ViewSettings,
  CustomFormation,
} from './types'

export const SCHEMA_VERSION = 2
// Storage keys keep the old name on purpose. Renaming one silently discards
// every board a guest has saved, which is a steep price for a string nobody
// sees. The same goes for `soccerboard.lastBoard` and the Postgres database.
const KEY = 'soccerboard.board'

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
 * The version number alone is not enough: board data now arrives over the
 * network, and a truncated or hand-edited record can carry the right version
 * with half its arrays missing. Checking the shape here means a bad board
 * falls back to a fresh one instead of crashing the app on load.
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

/** Returns false when the board could not be written, so callers can report it. */
export function saveBoard(data: PersistedBoard, key = KEY): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(data))
    return true
  } catch {
    // Storage is full or unavailable. Dropping the write keeps the board usable.
    return false
  }
}

/** `onProblem` receives a ready-to-show sentence when a stored board is discarded. */
export function loadBoard(
  key = KEY,
  onProblem?: (message: string) => void,
): PersistedBoard | null {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!isPersistedBoard(parsed)) {
      onProblem?.(
        'Your saved board came from an older version of FootyBoard and could not be opened, so a fresh one is ready.',
      )
      return null
    }
    return parsed
  } catch {
    onProblem?.('Your saved board could not be read, so a fresh one is open. Nothing else was changed.')
    return null
  }
}
