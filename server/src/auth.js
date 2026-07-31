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

/**
 * Constant-time comparison, so a wrong password cannot be found by timing.
 *
 * A missing salt or digest is false rather than a throw. Guest accounts have
 * both columns null, and while no caller should reach here with one — `WHERE
 * email = $1` cannot match a null address — the difference between "false" and
 * "500 from `Buffer.from(null, 'hex')`" is the difference between a closed door
 * and a door that reports something about itself when pushed.
 */
export async function verifyPassword(password, salt, expectedHex) {
  if (typeof salt !== 'string' || typeof expectedHex !== 'string') return false
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
    `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.created_at, u.is_guest,
            u.totp_confirmed_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    tokenDigest(token),
    Date.now(),
  )
  if (!row) return null
  // Same shape the routes return, so callers never see raw column names.
  //
  // `isGuest` travels with every authenticated request rather than being looked
  // up where it is needed, because the routes that must refuse a guest are the
  // credential routes, and a check they each have to remember to make is a check
  // one of them will eventually not make. `email` is null for a guest, and every
  // consumer of this shape has to expect that.
  //
  // `displayName` rides along for the same reason and has the same shape of
  // absence: null on any account created before the column existed. The socket
  // handshake is the caller that needs it — `identity()` decides what a room may
  // be told about somebody, and reading it here means that decision costs the
  // query every authenticated request already runs rather than one of its own.
  //
  // `twoFactorEnabled` rides along for the third version of the same reason: the
  // account menu and the two-step sign-in page both need to know whether the
  // factor is on, and `GET /api/auth/me` is where the client learns everything
  // else about itself, so a second endpoint asking the same row the same
  // question would be a round trip bought for nothing.
  //
  // **The sealed TOTP secret column is deliberately not in the SELECT above,
  // and adding it would be a real leak rather than an untidiness.** This
  // function builds the object that becomes `req.user` and is returned verbatim
  // by `GET /api/auth/me`, so a secret on it is one `res.json(req.user)` away
  // from the wire — and unlike a password digest, a TOTP secret is a live bearer
  // credential that generates codes. The column name is deliberately not written
  // out anywhere in this file, so that grepping this file for it stays a real
  // check on that property rather than a search that finds its own warning.
  //
  // The flag is derived from `totp_confirmed_at` for the reason `publicUser`
  // gives: an abandoned enrollment holds a secret and is not a factor, and
  // reporting one as "on" would be a lockout rather than a wrong label.
  return {
    id: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? null,
      createdAt: row.created_at,
      isGuest: row.is_guest === true,
      twoFactorEnabled: row.totp_confirmed_at != null,
    },
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

/**
 * Setting and clearing the session cookie, in one place.
 *
 * These lived in `routes/auth.js` while it was the only router minting sessions.
 * Guest admission in `routes/shares.js` mints one too, and a second spelling of
 * "how a session cookie is set" is exactly what the note on `SESSION_COOKIE`
 * above warns about: the attributes have to match for a clear to replace a live
 * cookie, and `maxAge` has to be on the way in and off the way out.
 */
export const signIn = (res, token) =>
  res.cookie(COOKIE_NAME, token, { ...SESSION_COOKIE, maxAge: SESSION_TTL_MS })

export const signOut = (res) => res.clearCookie(COOKIE_NAME, SESSION_COOKIE)

/**
 * A value that is not valid percent-encoding, handed back as it arrived.
 *
 * `decodeURIComponent('%')` throws a URIError, and this parser runs on every
 * request in the middleware that resolves `req.user` — so `Cookie: sb_session=%`
 * from anybody at all threw out of that middleware, reached the error handler
 * with no `status` on it, and was answered 500 with a stack printed beside it.
 * A stranger could pick how much went into the log stream, and the server
 * reported its own fault for a header the client sent.
 *
 * **Tolerating it rather than answering 400, and the reason is next door.**
 * `POST /api/auth/logout` is the only endpoint that clears this cookie, and it
 * reads it first — so refusing every request carrying an undecodable cookie
 * would also refuse the one call that would fix it, and a browser cannot delete
 * an httpOnly cookie from JavaScript. A 400 would therefore turn a mangled
 * cookie into a permanent one. Handing the raw value back cannot let anybody in:
 * tokens are base64url and stored as SHA-256, so a string that failed to decode
 * hashes to something no row holds, and the request is simply unauthenticated.
 *
 * This is also what the `cookie` package Express itself uses does, for the same
 * reason, which is worth knowing before anyone decides it is too lenient.
 */
const decodeCookieValue = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Minimal cookie parser — we only ever need our own key. */
export function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeCookieValue(rest.join('='))
  }
  return null
}
