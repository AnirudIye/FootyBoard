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
  SECURITY_QUESTIONS,
  validateSecurityQuestionId,
  validateSecurityAnswer,
  hashAnswer,
  verifyAnswer,
  questionFor,
  DECOY_ANSWER,
} from '../securityQuestions.js'
import {
  hashPassword,
  verifyPassword,
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  COOKIE_NAME,
  readCookie,
} from '../auth.js'
import { destroySession, destroyAllSessions } from '../sessions.js'
import {
  assertMayAttempt,
  recordFailure,
  clearFailures,
  assertMayAnswer,
  recordAnswerFailure,
  consume,
  addressKey,
  clearAllowance,
} from '../rateLimit.js'
import { createResetToken, consumeResetToken, RESET_TTL_MINUTES } from '../passwordReset.js'

export const authRouter = Router()

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

/**
 * The question list, served rather than shipped twice.
 *
 * The client renders the dropdown from this and the server validates every
 * submitted id against the same array, so there is one list and no way for the
 * two sides to disagree about what is on it. A second copy in the frontend
 * would be a constant hand-copied across a boundary, which is how this repo has
 * shipped work dark before.
 *
 * Public, because both the places that need it (signing up, and recovering an
 * account) happen before anyone is signed in. It is not secret: which questions
 * exist says nothing about who has answered which.
 */
authRouter.get('/security-questions', (_req, res) => {
  res.json({ questions: SECURITY_QUESTIONS })
})

authRouter.post('/signup', async (req, res) => {
  const { email, password, acceptedTerms, securityQuestionId, securityAnswer } = req.body ?? {}
  const cleanEmail = validateEmail(email)
  const cleanPassword = validatePassword(password)
  validateAcceptedTerms(acceptedTerms)
  const questionId = validateSecurityQuestionId(securityQuestionId)
  const answer = validateSecurityAnswer(securityAnswer)

  // Signups are rate limited per IP so the table cannot be flooded.
  await consume(`signup:${req.clientIp}`, {
    max: 10,
    windowMs: 60 * 60 * 1000,
    message: 'Too many accounts created from this network. Try again later.',
  })

  const { hash, salt } = await hashPassword(cleanPassword)
  const answerDigest = await hashAnswer(answer)
  const now = new Date().toISOString()
  const id = randomUUID()

  try {
    await run(
      `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                          security_question_id, security_answer_hash, security_answer_salt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      id,
      cleanEmail,
      hash,
      salt,
      now,
      now,
      questionId,
      answerDigest.hash,
      answerDigest.salt,
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
 * Change the password while signed in, and re-set the security question with
 * it.
 *
 * Both halves are required, not offered. The question is the only way back into
 * an account whose password has been forgotten, so the moment someone is
 * demonstrably in front of their account and thinking about credentials is
 * exactly the moment to make sure it is one they still know the answer to. An
 * optional field here would be skipped by everyone and would leave the recovery
 * path resting on whatever was typed at signup years earlier.
 *
 * The current password is required for the ordinary reason: a session left open
 * on a shared machine must not be enough to lock its owner out of their own
 * account.
 *
 * Every other session is destroyed, which is the same rule a reset follows and
 * for the same reason. The one difference is that the person doing it keeps
 * their access: a new session is minted for this request, so "sign out
 * everywhere" does not mean "including me, without warning".
 *
 * That includes the socket half. The session this request arrived on is one of
 * the ones being destroyed, so its rooms close with all the others and the
 * browser reconnects on the cookie it is handed below. Evictions are matched on
 * the session and not on the user precisely so that the *new* one is untouched:
 * matching on the user would either spare every socket this person had, which
 * is the hole, or close a session that was minted a millisecond ago.
 */
authRouter.post('/password', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })

  const { currentPassword, password, securityQuestionId, securityAnswer } = req.body ?? {}
  if (typeof currentPassword !== 'string' || !currentPassword)
    throw new BadRequest('Enter your current password.', 'currentPassword')
  const nextPassword = validatePassword(password)
  const questionId = validateSecurityQuestionId(securityQuestionId)
  const answer = validateSecurityAnswer(securityAnswer)

  const row = await get('SELECT password_hash, password_salt FROM users WHERE id = $1', req.user.id)
  if (!row) return res.status(401).json({ error: 'Not signed in.' })

  if (!(await verifyPassword(currentPassword, row.password_salt, row.password_hash)))
    throw new BadRequest('That is not your current password.', 'currentPassword')

  const next = await hashPassword(nextPassword)
  const answerDigest = await hashAnswer(answer)

  await destroyAllSessions(async (client) => {
    await client.query(
      `UPDATE users
          SET password_hash = $1, password_salt = $2,
              security_question_id = $3, security_answer_hash = $4, security_answer_salt = $5
        WHERE id = $6`,
      [next.hash, next.salt, questionId, answerDigest.hash, answerDigest.salt, req.user.id],
    )
    // Anything still holding a reset link for this account is void: the
    // password it was going to change has already changed.
    await client.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [
      req.user.id,
    ])
    // Returning the id is what destroys the sessions, in this same transaction,
    // and closes every socket they were holding once it commits.
    return req.user.id
  })

  signIn(res, await createSession(req.user.id))
  res.json({ ok: true })
})

/**
 * Step one of recovery: which question is on this account.
 *
 * **Every address gets a question**, whether or not it has an account. Saying
 * "no such account", or answering with a different shape or status, would turn
 * this into a way to test which addresses are registered, which is the property
 * the old generic replies existed to protect and the one thing that made
 * dropping the email step affordable at all.
 *
 * So an address with no account gets one derived from the address itself: fixed
 * per address, so probing twice does not give the game away by changing its
 * mind, and keyed on SESSION_SECRET so the mapping cannot be worked out offline
 * and compared against what we actually answer. An account from before this
 * feature has no stored question and takes the same path, and its answer will
 * then fail at step two exactly the way a wrong one does.
 *
 * Still rate limited per address and per IP. There is no inbox to spam any
 * more, but harvesting is its own reason, and these are allowances the flow
 * already had.
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

  const user = await get('SELECT security_question_id FROM users WHERE email = $1', cleanEmail)

  res.json({ question: questionFor(cleanEmail, user?.security_question_id ?? null) })
})

/**
 * Step two: answer it, and get the reset token.
 *
 * This is the whole authenticator now, so it is the endpoint that has to be
 * hard to grind. Two allowances stand in front of it, both counting **failures
 * only**: five wrong answers lock the address for fifteen minutes, and twenty
 * from one network in ten minutes shut the network out. Counting successes too
 * would punish the case the flow exists for without slowing a guesser down by
 * one attempt, since guessing produces nothing but failures.
 *
 * The check happens before the answer is compared, which is the half that
 * matters: a limiter charged only on the failure path, with no read in front of
 * it, refuses the wrong guesses and waves the right one through.
 *
 * Every failure looks the same from outside. An unknown address, an account
 * with no question set, and a wrong answer all get one message and one status,
 * and all three pay for a full scrypt derivation, so the clock does not answer
 * the question the wording refuses to.
 */
authRouter.post('/forgot/verify', async (req, res) => {
  const cleanEmail = validateEmail(req.body?.email)
  const answer = typeof req.body?.answer === 'string' ? req.body.answer : ''

  await assertMayAnswer({ email: cleanEmail, ip: req.clientIp })

  const user = await get(
    'SELECT id, security_answer_hash, security_answer_salt FROM users WHERE email = $1',
    cleanEmail,
  )

  // Nothing stored, either because there is no account or because this one
  // predates the feature. The comparison still runs, against a digest that
  // cannot match, so the reply costs what a real one costs.
  const stored =
    user?.security_answer_hash && user?.security_answer_salt
      ? { hash: user.security_answer_hash, salt: user.security_answer_salt }
      : DECOY_ANSWER

  const matched = await verifyAnswer(answer, stored.salt, stored.hash)
  const ok = matched && stored !== DECOY_ANSWER

  if (!ok) {
    await recordAnswerFailure({ email: cleanEmail, ip: req.clientIp })
    throw new BadRequest('That answer is not right. Check it and try again.', 'answer')
  }

  /**
   * Deliberately not handing the allowance back. Answering correctly proves
   * this attempt was right, not that the ones before it were honest, and a
   * refill would let a guesser reset the counter the moment they landed on an
   * account whose answer they had already found.
   */
  res.json({ token: await createResetToken(user.id), expiresInMinutes: RESET_TTL_MINUTES })
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
    throw new BadRequest('That reset request is invalid or has expired. Start again.', 'token')
  }

  /**
   * The reset happened, so the allowance that was rationing requests for it
   * goes back. Without this, five requests plus a successful reset still leaves
   * the address unable to ask again for an hour, which is a lockout imposed on
   * the person who just proved they hold the account.
   *
   * Only the step-one allowance. The one guarding the answer is left exactly
   * where it is, for the reason given above it.
   */
  const owner = await get('SELECT email FROM users WHERE id = $1', userId)
  if (owner) await clearAllowance(forgotKey(owner.email))

  // Their old cookie is dead now; clear it so the UI shows them signed out.
  signOut(res)
  res.json({ ok: true })
})

/**
 * Sign out of this browser.
 *
 * One session, not the account's: the other places somebody is signed in are
 * none of this request's business. `destroySession` closes whatever rooms this
 * session had open along with the row, so the tab that was left on a board does
 * not go on collaborating after the person signed out of it.
 */
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
  /**
   * Sessions and boards cascade from the user row, and a cascade tells nobody.
   *
   * So the sessions go first and explicitly, which closes the rooms they were
   * holding. Without that, deleting the account left every socket it had open
   * still relaying edits into boards that belonged to *other* people, which the
   * cascade does not touch and which the deleted account is no longer a member
   * of. The two statements are not one transaction on purpose: if the second
   * fails, an account survives with no sessions, and its owner signs in again.
   */
  await destroyAllSessions(() => req.user.id)
  await run('DELETE FROM users WHERE id = $1', req.user.id)
  signOut(res)
  res.status(204).end()
})
