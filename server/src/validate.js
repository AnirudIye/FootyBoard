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
/**
 * Shorter than a board name, because this one is drawn in a cursor label and a
 * 40px presence chip rather than in a heading. Sixty is comfortably more than
 * any real name and still fits the places it has to fit.
 */
const MAX_DISPLAY_NAME = 60
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

/**
 * The name a person chooses for the room to call them.
 *
 * **An `@` is refused, and that is a property of the system rather than good
 * manners.** `anonymousPresence.test.js` asserts bluntly that no `@` appears
 * anywhere in three sockets' traffic, which is the whole guarantee behind the
 * owner's anonymity switch. If a display name could carry one, that assertion
 * would stop being a fact about what the relay sends and become a hope about
 * what people type: somebody who set their name to their address would put it
 * back on the wire of an anonymous board, and the test that is supposed to catch
 * exactly that would keep passing because the test's own accounts do not do it.
 * `realtimeStore`'s `shownName` also splits on `@` to drop a domain, so a name
 * containing one would arrive at a cursor label cut in half.
 *
 * Required rather than optional at signup and at `/claim`, which is enforced by
 * the callers rather than here: those are the two places an account comes into
 * existence with credentials, so demanding it there is what makes every new
 * account safe by construction.
 */
export function validateDisplayName(raw) {
  if (raw === undefined || raw === null)
    throw new BadRequest('Choose the name other people will see.', 'displayName')
  const name = requireString(raw, 'displayName')
  if (!name) throw new BadRequest('Choose the name other people will see.', 'displayName')
  if (name.length > MAX_DISPLAY_NAME)
    throw new BadRequest(
      `Use a name shorter than ${MAX_DISPLAY_NAME} characters.`,
      'displayName',
    )
  if (name.includes('@'))
    throw new BadRequest(
      'A display name cannot contain an @. It is shown to everyone on the board, which is the one thing an email address should not be.',
      'displayName',
    )
  return name
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

/**
 * The generation the caller believes it is writing on top of.
 *
 * Required rather than optional, which is the decision worth defending. An
 * optional check is one an old bundle skips, and the write it would skip is
 * precisely the one this exists to refuse: a debounced autosave carrying contents
 * from before somebody else replaced the whole board. Client and server ship
 * together here, exactly as they must for the exact schema version check in
 * `boardSchema.js`, so refusing an absent value costs nothing and closes the hole
 * that "be lenient about it" would leave open forever.
 */
export function validateBaseGeneration(value) {
  if (!Number.isInteger(value) || value < 1)
    throw new BadRequest(
      'That save did not say which version of the board it was based on.',
      'baseGeneration',
    )
  return value
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
