import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { get, run } from './db.js'
import { isProduction } from './env.js'

const scryptAsync = promisify(scrypt)

/**
 * Passwords are stored as scrypt digests with a per-user salt.
 *
 * scrypt is deliberately slow and memory-hard, which is the whole point: a
 * plain SHA-256 can be brute-forced at billions of guesses a second, while
 * these parameters put a single guess in the tens of milliseconds. The
 * password itself is never written anywhere.
 */
const KEYLEN = 64
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, KEYLEN, SCRYPT_PARAMS)
  return { hash: derived.toString('hex'), salt }
}

/** Constant-time comparison, so a wrong password cannot be found by timing. */
export async function verifyPassword(password, salt, expectedHex) {
  const derived = await scryptAsync(password, salt, KEYLEN, SCRYPT_PARAMS)
  const expected = Buffer.from(expectedHex, 'hex')
  if (expected.length !== derived.length) return false
  return timingSafeEqual(derived, expected)
}

/**
 * Sessions are opaque random tokens. Only their SHA-256 is stored, so a stolen
 * database still does not yield usable cookies, and a session can be revoked
 * by deleting one row.
 *
 * Exported because `sessions.js` ends a session by the same digest, and two
 * copies of "how a token becomes a row" is exactly how a revocation ends up
 * deleting nothing.
 */
export const tokenDigest = (token) => createHash('sha256').update(token).digest('hex')

export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url')
  await run(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    randomUUID(),
    userId,
    tokenDigest(token),
    Date.now() + SESSION_TTL_MS,
    new Date().toISOString(),
  )
  return token
}

/**
 * Resolves a cookie token to the session row *and* its user, or null. One
 * indexed join, not two queries.
 *
 * The session's own id is what a WebSocket needs and a request handler does
 * not. A socket is authenticated once, at the handshake, and never again, so
 * the only way it can be closed when that session is destroyed is if it
 * remembers which session let it in. Every other caller goes through
 * `userForToken` below and gets the shape it always got, which keeps the id out
 * of `GET /api/auth/me` rather than trusting each route to strip it.
 */
export async function sessionForToken(token) {
  if (!token) return null
  const row = await get(
    `SELECT s.id AS session_id, u.id, u.email, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    tokenDigest(token),
    Date.now(),
  )
  if (!row) return null
  // Same shape the routes return, so callers never see raw column names.
  return {
    id: row.session_id,
    user: { id: row.id, email: row.email, createdAt: row.created_at },
  }
}

/** Resolves a cookie token to its user, or null. */
export const userForToken = async (token) => (await sessionForToken(token))?.user ?? null

export const COOKIE_NAME = 'sb_session'

/**
 * How the session cookie is set, and cleared, everywhere it is.
 *
 * One object rather than a string built per route, so setting and clearing
 * cannot drift: a cleared cookie only actually replaces the live one when every
 * attribute matches, and a `Secure` that appears on the way in but not on the
 * way out leaves a signed-out browser still holding a session cookie.
 *
 * `secure` follows APP_ENV, not the absence of one. Spread `maxAge` on at the
 * call site that is setting a session; leaving it off is what `clearCookie`
 * wants.
 */
export const SESSION_COOKIE = {
  httpOnly: true, // unreadable from JavaScript, so XSS cannot lift it
  sameSite: 'lax', // blocks the cookie on cross-site form posts
  path: '/',
  secure: isProduction,
}

/** Minimal cookie parser — we only ever need our own key. */
export function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}
