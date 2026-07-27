import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { get, run } from '../db.js'
import {
  validateEmail,
  validatePassword,
  validateAcceptedTerms,
  BadRequest,
} from '../validate.js'
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  COOKIE_NAME,
  readCookie,
} from '../auth.js'
import {
  assertMayAttempt,
  recordFailure,
  clearFailures,
  consume,
  addressKey,
  clearAllowance,
} from '../rateLimit.js'
import { createResetToken, consumeResetToken, RESET_TTL_MINUTES } from '../passwordReset.js'
import { send, passwordResetEmail } from '../mailer.js'
import { ORIGIN } from '../env.js'

export const authRouter = Router()

// Where the reset link should point — the app, not the API.
const APP_ORIGIN = process.env.APP_ORIGIN ?? ORIGIN
const publicUser = (row) => ({ id: row.id, email: row.email, createdAt: row.created_at })

const signIn = (res, token) =>
  res.cookie(COOKIE_NAME, token, { ...SESSION_COOKIE, maxAge: SESSION_TTL_MS })
const signOut = (res) => res.clearCookie(COOKIE_NAME, SESSION_COOKIE)

/**
 * The allowance guarding "forgot password" for one address.
 *
 * Keyed on a digest rather than the address, because the address arrives in an
 * unauthenticated request body: counting it verbatim writes a list of who has
 * been asked about into a table that exists to count, and lets anyone insert
 * rows with a key of their choosing.
 */
const forgotKey = (email) => addressKey('forgot', email)

authRouter.post('/signup', async (req, res) => {
  const { email, password, acceptedTerms } = req.body ?? {}
  const cleanEmail = validateEmail(email)
  const cleanPassword = validatePassword(password)
  validateAcceptedTerms(acceptedTerms)

  // Signups are rate limited per IP so the table cannot be flooded.
  await consume(`signup:${req.clientIp}`, {
    max: 10,
    windowMs: 60 * 60 * 1000,
    message: 'Too many accounts created from this network. Try again later.',
  })

  const { hash, salt } = await hashPassword(cleanPassword)
  const now = new Date().toISOString()
  const id = randomUUID()

  try {
    await run(
      `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      id,
      cleanEmail,
      hash,
      salt,
      now,
      now,
    )
  } catch (err) {
    // The unique index on email is the source of truth for "already taken",
    // which avoids a check-then-insert race between two simultaneous signups
    // — including two landing on different API instances. 23505 is Postgres'
    // unique_violation.
    if (err.code === '23505')
      throw new BadRequest('An account already exists for that email. Log in instead.', 'email')
    throw err
  }

  signIn(res, await createSession(id))
  res.status(201).json({ user: { id, email: cleanEmail, createdAt: now } })
})

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  const cleanEmail = validateEmail(email)
  const cleanPassword = validatePassword(password)

  await assertMayAttempt({ email: cleanEmail, ip: req.clientIp })

  const row = await get(
    `SELECT id, email, password_hash, password_salt, created_at
       FROM users WHERE email = $1`,
    cleanEmail,
  )

  const ok = row ? await verifyPassword(cleanPassword, row.password_salt, row.password_hash) : false

  if (!ok) {
    await recordFailure({ email: cleanEmail, ip: req.clientIp })
    // One message whether the address is unknown or the password is wrong,
    // so the endpoint cannot be used to enumerate who has an account.
    const err = new Error('Incorrect email or password.')
    err.status = 401
    throw err
  }

  await clearFailures({ email: cleanEmail })
  signIn(res, await createSession(row.id))
  res.json({ user: publicUser(row) })
})

/**
 * Ask for a reset link.
 *
 * The reply is identical whether or not the address has an account — otherwise
 * this becomes a way to test which emails are registered. The work is also
 * rate limited per address and per IP so it cannot be used to spam someone's
 * inbox.
 */
authRouter.post('/forgot', async (req, res) => {
  const cleanEmail = validateEmail(req.body?.email)

  await consume(forgotKey(cleanEmail), {
    max: 5,
    windowMs: 60 * 60 * 1000,
    message: 'That address has been asked for too many times. Try again later.',
  })
  await consume(`forgot-ip:${req.clientIp}`, {
    max: 20,
    windowMs: 60 * 60 * 1000,
    message: 'Too many requests from this network. Try again later.',
  })

  const user = await get('SELECT id, email FROM users WHERE email = $1', cleanEmail)

  if (user) {
    const token = await createResetToken(user.id)
    const link = `${APP_ORIGIN}/reset?token=${encodeURIComponent(token)}`
    try {
      await send(passwordResetEmail({ to: user.email, link, minutes: RESET_TTL_MINUTES }))
    } catch (err) {
      // Logged, not surfaced: a mail outage must not change the response and
      // give away that the account exists.
      console.error('Could not send reset email:', err.message)
    }
  }

  res.json({ ok: true })
})

/** Complete a reset. Signs every session out, so the new password is the only way back in. */
authRouter.post('/reset', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : ''
  const password = validatePassword(req.body?.password)

  await consume(`reset-ip:${req.clientIp}`, {
    max: 20,
    windowMs: 60 * 60 * 1000,
    message: 'Too many attempts from this network. Try again later.',
  })

  const userId = token ? await consumeResetToken(token, password) : null
  if (!userId) {
    throw new BadRequest('That reset link is invalid or has expired. Request a new one.', 'token')
  }

  /**
   * The reset happened, so the allowance that was rationing requests for it
   * goes back. Without this, five requests plus a successful reset still leaves
   * the address unable to ask again for an hour, which is a lockout imposed on
   * the person who just proved they hold the mailbox.
   */
  const owner = await get('SELECT email FROM users WHERE id = $1', userId)
  if (owner) await clearAllowance(forgotKey(owner.email))

  // Their old cookie is dead now; clear it so the UI shows them signed out.
  signOut(res)
  res.json({ ok: true })
})

authRouter.post('/logout', async (req, res) => {
  await destroySession(readCookie(req.headers.cookie, COOKIE_NAME))
  signOut(res)
  res.status(204).end()
})

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  res.json({ user: req.user })
})

authRouter.delete('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  // Sessions and boards cascade from the user row.
  await run('DELETE FROM users WHERE id = $1', req.user.id)
  signOut(res)
  res.status(204).end()
})
