/**
 * Server-side input validation.
 *
 * The client does its own checking for the sake of fast feedback, but that is
 * a convenience, not a control — anyone can post straight to the API. Every
 * request is validated again here, and nothing reaches SQL except as a bound
 * parameter.
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

export function validateBoardName(raw) {
  const name = requireString(raw ?? 'Untitled board', 'name')
  if (!name) throw new BadRequest('Give the board a name.', 'name')
  if (name.length > MAX_NAME) throw new BadRequest('That board name is too long.', 'name')
  return name
}

/**
 * Boards are stored as JSON text. We re-serialise what was sent rather than
 * trusting the raw string, so only well-formed JSON of a sane size is written.
 */
export function validateBoardData(value) {
  if (value === undefined || value === null) throw new BadRequest('The board is missing.', 'data')
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    throw new BadRequest('That board could not be read.', 'data')
  }
  if (text === undefined) throw new BadRequest('That board could not be read.', 'data')
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
