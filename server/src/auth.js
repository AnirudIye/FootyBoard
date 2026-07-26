import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { get, run } from './db.js'

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
 */
const tokenDigest = (token) => createHash('sha256').update(token).digest('hex')

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

/** Resolves a cookie token to its user, or null. One indexed join, not two queries. */
export async function userForToken(token) {
  if (!token) return null
  const row = await get(
    `SELECT u.id, u.email, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    tokenDigest(token),
    Date.now(),
  )
  // Same shape the routes return, so callers never see raw column names.
  return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
}

export async function destroySession(token) {
  if (!token) return 0
  const { changes } = await run('DELETE FROM sessions WHERE token_hash = $1', tokenDigest(token))
  return changes
}

export const COOKIE_NAME = 'sb_session'

export function sessionCookie(token, { secure }) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly', // unreadable from JavaScript, so XSS cannot lift it
    'SameSite=Lax', // blocks the cookie on cross-site form posts
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export const clearedCookie = ({ secure }) =>
  [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ')

/** Minimal cookie parser — we only ever need our own key. */
export function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}
