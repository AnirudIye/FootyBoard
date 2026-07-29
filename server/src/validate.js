import { isPersistedBoard } from '../../src/lib/boardSchema.js'

/**
 * Server-side input validation.
 *
 * The client does its own checking for the sake of fast feedback, but that is
 * a convenience, not a control — anyone can post straight to the API. Every
 * request is validated again here, and nothing reaches SQL except as a bound
 * parameter.
 *
 * One import crosses into the frontend tree, deliberately: `boardSchema.js` is
 * the single definition of what a board payload is, and both ends have to agree
 * about that or the server writes rows the client cannot open. It is plain
 * JavaScript for exactly this reason. See the note in that file, and note the
 * coupling it creates: `server/` no longer runs from a copy of itself alone.
 */

export class BadRequest extends Error {
  constructor(message, field) {
    super(message)
    this.name = 'BadRequest'
    this.status = 400
    this.field = field
  }
}

const MAX_EMAIL = 254 // RFC 5321
const MAX_PASSWORD = 200
const MIN_PASSWORD = 8
const MAX_NAME = 120
const MAX_BOARD_BYTES = 512 * 1024

/** Strips control characters, which have no place in a submitted field. */
const clean = (value) => String(value).replace(/[\x00-\x1F\x7F]/g, '').trim()

function requireString(value, field) {
  if (typeof value !== 'string') throw new BadRequest(`${field} must be text.`, field)
  return clean(value)
}

export function validateEmail(raw) {
  const email = requireString(raw, 'email').toLowerCase()
  if (!email) throw new BadRequest('Enter your email address.', 'email')
  if (email.length > MAX_EMAIL) throw new BadRequest('That email address is too long.', 'email')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new BadRequest('Enter an email address in the form name@example.com.', 'email')
  return email
}

export function validatePassword(raw) {
  const password = requireString(raw, 'password')
  if (password.length < MIN_PASSWORD)
    throw new BadRequest(`Use a password of at least ${MIN_PASSWORD} characters.`, 'password')
  if (password.length > MAX_PASSWORD)
    throw new BadRequest(`Use a password shorter than ${MAX_PASSWORD} characters.`, 'password')
  return password
}

export function validateAcceptedTerms(value) {
  if (value !== true)
    throw new BadRequest('Accept the Terms of Service and Privacy Policy to continue.', 'acceptedTerms')
  return true
}

/**
 * A missing name is a bad request, not a name.
 *
 * This used to default to 'Untitled board', which reads as a kindness until you
 * notice which callers reach it: `PATCH /api/boards/:id` exists only to rename,
 * so an empty body meant the owner's title was silently replaced with the
 * default and answered 200. The one caller that genuinely wants a fallback is
 * board creation, and it now supplies its own.
 */
export function validateBoardName(raw) {
  if (raw === undefined || raw === null) throw new BadRequest('Give the board a name.', 'name')
  const name = requireString(raw, 'name')
  if (!name) throw new BadRequest('Give the board a name.', 'name')
  if (name.length > MAX_NAME) throw new BadRequest('That board name is too long.', 'name')
  return name
}

/**
 * Boards are stored as JSON text. We re-serialise what was sent rather than
 * trusting the raw string, so only well-formed JSON of a sane size is written.
 *
 * **And only an actual board.** This used to check presence and size and
 * nothing else, so `POST /api/boards` with a body of `{"v":1}` answered 201 and
 * wrote the row. The client then refused to open it, because `isPersistedBoard`
 * runs on read and is a real check: six rows in the dev database are exactly
 * that, and the whole "That board could not be opened" path exists to cope with
 * what this endpoint let through.
 *
 * The guard is imported rather than written out again, and that is the point of
 * the fix rather than an implementation detail. "Is this loadable?" and "is this
 * storable?" are one question, and while each end answered it separately the
 * server could go on accepting rows the client would refuse. Two copies would
 * also make the dangerous direction possible: a server check that drifted
 * *stricter* than the client's own serialiser refuses every save the real app
 * makes, which is far worse than the rows it prevents. One function cannot
 * drift either way.
 */
export function validateBoardData(value) {
  if (value === undefined || value === null) throw new BadRequest('The board is missing.', 'data')
  if (!isPersistedBoard(value))
    throw new BadRequest('That board is not in a format this version can save.', 'data')
  // Whatever this is, it came back out of express.json(), so it is already a
  // JSON value: nothing here can be circular, and nothing can serialise to
  // undefined once null has been turned away above.
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, 'utf8') > MAX_BOARD_BYTES)
    throw new BadRequest('That board is too large to save.', 'data')
  return text
}

/** Pagination inputs, clamped so a caller cannot ask for the whole table. */
export function validatePageQuery({ limit, cursor }) {
  const parsed = Number.parseInt(limit ?? '20', 10)
  const size = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 20
  return {
    limit: size,
    cursor: cursor ? requireString(cursor, 'cursor').slice(0, 200) : null,
  }
}
