import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { get, run } from '../db.js'
import {
  validateEmail,
  validatePassword,
  validateAcceptedTerms,
  validateDisplayName,
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
  signIn,
  signOut,
  COOKIE_NAME,
  readCookie,
} from '../auth.js'
import { destroySession, destroyAllSessions } from '../sessions.js'
import { renameSockets } from '../realtime.js'
import {
  assertMayAttempt,
  recordFailure,
  clearFailures,
  assertMayAnswer,
  recordAnswerFailure,
  assertMayUseFactor,
  recordFactorFailure,
  consume,
  addressKey,
  clearAllowance,
} from '../rateLimit.js'
import { createResetToken, consumeResetToken, RESET_TTL_MINUTES } from '../passwordReset.js'
import {
  beginEnrollment,
  confirmEnrollment,
  verifyFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
  remainingRecoveryCodes,
  createChallenge,
  consumeChallenge,
  CHALLENGE_TTL_MINUTES,
} from '../twoFactor.js'

export const authRouter = Router()

/**
 * `is_guest` is read off the row rather than defaulted, because these two
 * callers are `/signup` and `/login` and both of them are, by construction,
 * about accounts that have credentials. Reading it keeps the shape identical to
 * the one `sessionForToken` builds, so the client sees one user object rather
 * than two that mostly agree.
 *
 * **`twoFactorEnabled` is derived from `totp_confirmed_at` and never from the
 * presence of a secret.** A row can hold a sealed secret and still have the
 * factor off, because that is what an enrollment somebody started and abandoned
 * looks like, and reporting that as "on" would be a lockout on the account page
 * for a factor no authenticator can satisfy. Every caller of this function has
 * to carry the column in its SELECT or RETURNING, which is the failure recorded
 * two paragraphs down and the reason `twoFactorEnroll.test.js` asserts the field
 * on all four endpoints that return a user rather than on one of them.
 *
 * The secret itself is never in this shape and must never be added to it. This
 * object is what `res.json` sends.
 */
const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name ?? null,
  createdAt: row.created_at,
  isGuest: row.is_guest === true,
  twoFactorEnabled: row.totp_confirmed_at != null,
})

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

/**
 * `displayName` is required here, and that is the load-bearing half of the
 * feature rather than a field on a form.
 *
 * Presence names a member by their address unless something else is available, so
 * every account that reaches a room without a name is one that discloses an
 * address to everybody in it. Asking at signup is what makes each *new* account
 * safe by construction: there is no window in which the account exists, joins a
 * board, and has nothing to be called. Offering it later instead would mean
 * almost nobody set one, and the gap would stay open for exactly as long as the
 * feature existed.
 */
authRouter.post('/signup', async (req, res) => {
  const { email, password, acceptedTerms, securityQuestionId, securityAnswer, displayName } =
    req.body ?? {}
  const cleanEmail = validateEmail(email)
  const cleanPassword = validatePassword(password)
  const cleanDisplayName = validateDisplayName(displayName)
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
                          security_question_id, security_answer_hash, security_answer_salt,
                          display_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      id,
      cleanEmail,
      hash,
      salt,
      now,
      now,
      questionId,
      answerDigest.hash,
      answerDigest.salt,
      cleanDisplayName,
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
  // Through `publicUser`'s shape, not a hand-built one. Signup builds its row in
  // memory rather than reading it back, and an object assembled here silently
  // omitted `isGuest`, so the client's `ApiUser` said boolean and got undefined.
  res.status(201).json({
    user: publicUser({
      id,
      email: cleanEmail,
      display_name: cleanDisplayName,
      created_at: now,
      is_guest: false,
      // A new account has no factor. Written out rather than left to
      // `undefined != null` being false by luck, because this object is built by
      // hand and the last field that was left off here reached the client as
      // undefined against a type that said boolean.
      totp_confirmed_at: null,
    }),
  })
})

/**
 * Attach real credentials to a guest account.
 *
 * Guest admission solves the journey and creates a trap on the way: everything
 * that person saves belongs to an account with no address and no password, so it
 * is reachable only by one cookie, and when that cookie goes so does the work.
 * Signing up separately would not help, because it makes a *second* account and
 * leaves the boards behind on the first.
 *
 * So this sets the credentials on the row that already holds the work. It is a
 * signup in every respect except which id it writes to.
 *
 * **Guests only, and that is the security property, not a nicety.** No current
 * password is asked for, because a guest has none to give; so if this accepted a
 * real account it would be a password change for anybody holding a session, and
 * a session left open on a shared machine would be enough to take the account
 * over. `is_guest` is the whole gate, which is why it is a stored fact about how
 * the account came to exist rather than an inference from what it currently
 * lacks.
 *
 * One statement, guarded on `is_guest` in its own WHERE, so two requests racing
 * cannot both pass a check and then both set a password. The unique index on
 * email is what refuses a taken address, for the same reason signup leans on it:
 * a check-then-write races, including across instances.
 */
authRouter.post('/claim', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  if (!req.user.isGuest)
    throw new BadRequest('This account already has a password.', 'email')

  const { email, password, acceptedTerms, securityQuestionId, securityAnswer, displayName } =
    req.body ?? {}
  const cleanEmail = validateEmail(email)
  const cleanPassword = validatePassword(password)
  // Required here for the reason it is required at signup: this is the other
  // place an account gains credentials, and the account about to gain them is
  // one that has just acquired an address the room would otherwise start
  // disclosing. A guest who was `Anonymous Quokka` a moment ago must not become
  // their own email by claiming.
  const cleanDisplayName = validateDisplayName(displayName)
  validateAcceptedTerms(acceptedTerms)
  const questionId = validateSecurityQuestionId(securityQuestionId)
  const answer = validateSecurityAnswer(securityAnswer)

  // Same allowance signup counts against. Claiming is how an account gets
  // credentials, so leaving it uncounted would be a way around that limit.
  await consume(`signup:${req.clientIp}`, {
    max: 10,
    windowMs: 60 * 60 * 1000,
    message: 'Too many accounts created from this network. Try again later.',
  })

  const { hash, salt } = await hashPassword(cleanPassword)
  const answerDigest = await hashAnswer(answer)

  let updated
  try {
    updated = await get(
      `UPDATE users
          SET email = $1, password_hash = $2, password_salt = $3, is_guest = false,
              security_question_id = $4, security_answer_hash = $5, security_answer_salt = $6,
              display_name = $7
        WHERE id = $8 AND is_guest = true
        RETURNING id, email, display_name, created_at, is_guest, totp_confirmed_at`,
      cleanEmail,
      hash,
      salt,
      questionId,
      answerDigest.hash,
      answerDigest.salt,
      cleanDisplayName,
      req.user.id,
    )
  } catch (err) {
    if (err.code === '23505')
      throw new BadRequest('An account already exists for that email. Log in instead.', 'email')
    throw err
  }

  // No row means `is_guest` was already false: another request claimed this
  // account first, and it is not a guest any more.
  if (!updated) throw new BadRequest('This account already has a password.', 'email')

  /**
   * The session is deliberately left alone.
   *
   * Every other credential change here destroys every session, because it is
   * reached by somebody who may be locking an intruder out. This is the
   * opposite: the account had exactly one way in, the browser making this
   * request is holding it, and there is no older session to revoke. Destroying
   * and re-minting would be theatre.
   */
  res.json({ user: publicUser(updated) })
})

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  const cleanEmail = validateEmail(email)
  const cleanPassword = validatePassword(password)

  await assertMayAttempt({ email: cleanEmail, ip: req.clientIp })

  const row = await get(
    `SELECT id, email, display_name, password_hash, password_salt, created_at,
            totp_secret, totp_confirmed_at
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

  /**
   * The allowance goes back on a correct password even when no session follows.
   *
   * That counter guards the password, and the password was right. The factor has
   * its own keys, which is the rule the security answer already follows: burning
   * one allowance must not shut a door it does not guard, and leaving this one
   * spent would punish somebody who mistyped twice before getting it right and
   * then had to reach for their phone.
   */
  await clearFailures({ email: cleanEmail })

  /**
   * **The one line that is the whole feature: a correct password buys a
   * challenge and nothing else.**
   *
   * `signIn` and `createSession` are not reachable from this branch, and that is
   * the property rather than an implementation detail. If a session were minted
   * here the second factor would be decorative: whoever knows the password is
   * already signed in, and the code is a form they can close.
   *
   * It branches on `totp_confirmed_at` and never on `totp_secret`, so an
   * enrollment somebody started and abandoned is not a lockout.
   *
   * **200 with both keys, exactly one of them null**, rather than a 401 or a
   * distinct status. `request<T>` on the client throws for every non-2xx, so a
   * challenge delivered as an error would reach the page as a sentence with
   * nothing to spend. Both keys always present is the shape `getShare` already
   * uses, and it means `const { user } = await api.logIn(...)` goes on working
   * for every account that has no factor, which is every account until somebody
   * enrolls one.
   */
  if (row.totp_confirmed_at) {
    return res.json({
      user: null,
      challenge: {
        token: await createChallenge(row.id, 'login'),
        expiresInMinutes: CHALLENGE_TTL_MINUTES,
      },
    })
  }

  signIn(res, await createSession(row.id))
  res.json({ user: publicUser(row), challenge: null })
})

/**
 * The second step of signing in: spend the challenge, prove the factor, and
 * only then mint a session.
 *
 * **The account is named by the challenge row and never by the body**, which is
 * the property `/sessions` states about its cookie: there is no shape of this
 * request that signs somebody else in.
 *
 * **The challenge is claimed before the code is compared, so one challenge buys
 * exactly one guess.** That is deliberate and it is the difference between an
 * allowance of five attempts per fifteen minutes and an unlimited number of
 * attempts against a single password entry. The cost is real and is worth
 * stating: mistype the code and you enter your password again. For a step whose
 * whole job is to stand between somebody who already knows the password and the
 * account, that is the right side to err on.
 *
 * One message for a token that never existed, one already spent, one expired and
 * one issued for the recovery flow, exactly as `/auth/reset` gives one message
 * for every way a reset token can fail.
 */
authRouter.post('/login/2fa', async (req, res) => {
  const userId = await consumeChallenge(req.body?.token, 'login')
  if (!userId)
    throw new BadRequest(
      'That sign-in step has expired or has already been used. Enter your email and password again.',
      'token',
    )

  await assertFactor({
    userId,
    ip: req.clientIp,
    code: req.body?.code,
    message: WRONG_CODE,
  })

  const row = await get(
    `SELECT id, email, display_name, created_at, is_guest, totp_confirmed_at
       FROM users WHERE id = $1`,
    userId,
  )
  // The challenge resolved a moment ago and the row is gone, so the account was
  // deleted underneath this request. Nothing to sign in and nobody to sign in.
  if (!row) {
    const err = new Error('Incorrect email or password.')
    err.status = 401
    throw err
  }

  signIn(res, await createSession(row.id))
  res.json({ user: publicUser(row) })
})

/**
 * Set or change the name the room calls you.
 *
 * **PATCH rather than POST**, unlike every other route in this router. The
 * argument that made `/sessions` a POST does not apply: nothing is created, no
 * credential travels in the body, and there is no DELETE-with-a-body corner of
 * HTTP to avoid. What is left is a partial update of an account that already
 * exists, which is what the two owner switches in `shares.js` already use PATCH
 * for. It also cannot be reached by a plain HTML form, which is one fewer way for
 * a cross-site page to try, on top of the `SameSite=Lax` cookie.
 *
 * **No current password, and that is deliberate rather than an oversight.** A
 * display name is not a credential and changing it takes nothing away: anybody
 * holding this session can already open, edit and delete every board on the
 * account, so a password prompt here would buy nothing and cost the one group
 * this helps most. **A guest has no password at all**, and a guest is exactly who
 * needs this: with no address, the room could only ever call them
 * `Anonymous Quokka`, so a name they choose is strictly better than what they had.
 *
 * The account is named by the cookie and never by the body, so there is no shape
 * of this request that renames somebody else.
 *
 * No allowance. It is not an oracle for anything — no comparison happens, the
 * reply says nothing the caller did not already know, and it writes one column on
 * the caller's own row. The limiters here exist to slow guessing down, and there
 * is nothing here to guess.
 *
 * **The room hears it at once**, which for a while it did not: `identity()`
 * reads the name off the socket exactly as it reads the address, so writing the
 * column changed what the *next* connection would be told and nothing about the
 * rooms already open. Rename yourself mid session and everyone went on seeing
 * the old name until you reloaded. `renameSockets` is the other half, shaped
 * like `closeSessionSockets` for the same reason: the process holding somebody's
 * socket is almost never the one that served their request.
 *
 * Published after the write and only if it landed, so a rename that was refused
 * renames nobody, and the name that goes on the bus is the one the database
 * returned rather than the one that was asked for.
 */
authRouter.patch('/display-name', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })

  const displayName = validateDisplayName(req.body?.displayName)

  const updated = await get(
    `UPDATE users SET display_name = $1 WHERE id = $2
      RETURNING id, email, display_name, created_at, is_guest, totp_confirmed_at`,
    displayName,
    req.user.id,
  )
  // The session resolved a moment ago and the row is gone, so the account was
  // deleted underneath this request. Nothing to rename and nobody to rename it.
  if (!updated) return res.status(401).json({ error: 'Not signed in.' })

  renameSockets(updated.id, updated.display_name)
  res.json({ user: publicUser(updated) })
})

/**
 * The door the two credential controls share: prove the password this account
 * already has.
 *
 * Written once because it is the whole security property of both of them, and a
 * rule spelled out in two routes is a rule one of them eventually gets a weaker
 * version of. `/password` and `/sessions` are the same door with different things
 * behind it, and what they must never be is the same door with different locks: a
 * session left open on a shared machine must not be enough to change somebody's
 * password, and it must not be enough to sign them out of everywhere else either.
 *
 * **A guest is refused for being a guest, before the comparison.**
 * `verifyPassword` already answers false for the null salt and digest that row
 * carries, so the door is shut whether this branch exists or not, and the branch
 * is here for what it says rather than for what it stops: "that is not your
 * current password" describes an answer somebody with no password could never
 * have typed. It also keeps `is_guest` the gate rather than the absence of a
 * hash, which is the same fact `/claim` leans on from the other side.
 *
 * Called *after* the rest of a body has been validated, so a malformed request
 * does not pay for a scrypt derivation on its way to being told which field was
 * wrong.
 *
 * **`/password` and `/sessions` deliberately ask for no second factor, and the
 * absence is a decision rather than an oversight.** Both already require the
 * current password from a live session, so the attacker they would be guarding
 * against has to hold the session *and* the password; a factor there buys
 * nothing that person could not already do. What it would cost is real:
 * somebody whose phone has died could not change their own password, on the
 * control that exists precisely for the moment they suspect something is wrong.
 * `/2fa/disable` and `/2fa/recovery-codes` are the opposite case and do require
 * both, because those two are the ones that *remove* the factor, and a disable
 * behind the password alone would make the whole feature exactly as strong as
 * the password.
 */
async function assertCurrentPassword(user, currentPassword) {
  if (typeof currentPassword !== 'string' || !currentPassword)
    throw new BadRequest('Enter your current password.', 'currentPassword')

  if (user.isGuest)
    throw new BadRequest(
      'This account has no password to check. Give it one first.',
      'currentPassword',
    )

  const row = await get('SELECT password_hash, password_salt FROM users WHERE id = $1', user.id)
  // The session resolved a moment ago and the row is gone, so the account was
  // deleted underneath this request. Nothing to change and nobody to change it.
  if (!row) {
    const err = new Error('Not signed in.')
    err.status = 401
    throw err
  }

  /**
   * A held session must not be an unthrottled oracle for the password.
   *
   * Both callers verify the current password and neither used to count against
   * anything, so a session left open on a shared machine could guess its own
   * account's password at whatever rate the network allowed. Signing in is
   * limited and this was not, which made the limited door the expensive one.
   *
   * `consume` rather than the sign-in pair, for two reasons. Its keys are
   * **swept**: `purgeStaleAllowances` deliberately leaves `account:%` alone,
   * because that counter resets by serving a lockout rather than by going quiet,
   * so borrowing `assertMayAttempt` would leave one permanent row per person who
   * ever mistyped their own password. And its own namespace keeps this away from
   * sign-in, which is the rule the security answer already follows: burning one
   * allowance must not shut a door it does not guard.
   *
   * Unlike the join code and the security answer, this charges **successes too**,
   * and that is safe here for a reason those two do not have. A room full of
   * people redeem one code at once; confirming your own password is a rare,
   * deliberate act by one person, so ten in a quarter of an hour sits far above
   * any honest use and far below useful guessing.
   *
   * Before `verifyPassword`, so a spent allowance stops the attempt being
   * evaluated rather than merely counted after the fact.
   */
  await consume(`confirm:${user.id}`, {
    max: 10,
    windowMs: 15 * 60 * 1000,
    message: 'Too many password checks. Wait a few minutes and try again.',
  })

  if (!(await verifyPassword(currentPassword, row.password_salt, row.password_hash)))
    throw new BadRequest('That is not your current password.', 'currentPassword')
}

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
  const nextPassword = validatePassword(password)
  const questionId = validateSecurityQuestionId(securityQuestionId)
  const answer = validateSecurityAnswer(securityAnswer)

  await assertCurrentPassword(req.user, currentPassword)

  const next = await hashPassword(nextPassword)
  const answerDigest = await hashAnswer(answer)

  await destroyAllSessions(req.user.id, async (client) => {
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
 * End every session for this account, and change nothing else.
 *
 * `/password` above has always done this as a side effect, and for a while it was
 * the only control that did, which put the wrong price on it: somebody who
 * suspects a session has been taken had to invent a new password in order to
 * throw it out. This is the same door with the password change taken out.
 *
 * **POST rather than DELETE**, although the collection framing fits and would
 * read well. The deciding reason is that this does not only delete: it mints a
 * session and sets a cookie, so the response creates as much as it removes. The
 * second reason is that the request cannot afford to lose its body. The current
 * password is what makes this useless to somebody holding a stolen session, and a
 * body on a DELETE is the corner of HTTP that clients, caches and proxies are
 * least careful with. Every other credential-carrying route in this router is a
 * POST as well.
 *
 * The current password is required for the reason `/password` requires it, and
 * more so: this is the control reached by somebody who believes another person is
 * in their account, so it has to be worth nothing to that other person.
 *
 * **The caller is not locked out and is not spared.** Every session goes,
 * including the one this request arrived on, and then one is minted for this
 * browser. The eviction is matched on the session rather than on the user, which
 * is exactly what lets the new one live while the caller's old one dies with
 * everybody else's: the caller's own rooms close and the browser reconnects on the
 * cookie below. Sparing the sockets belonging to whoever asked would be the same
 * hole reached from the friendlier direction.
 *
 * Outstanding reset links are deliberately left alone, unlike in `/password`.
 * There they are void because the password they were going to set has already
 * been set; here nothing about the password changed, so a link somebody is halfway
 * through using still names a real request. Worth knowing that this means the
 * endpoint ends sessions and only sessions.
 */
authRouter.post('/sessions', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  // The account is named by the cookie and never by the body, so there is no
  // shape of this request that ends somebody else's sessions.
  await assertCurrentPassword(req.user, req.body?.currentPassword)

  /**
   * A pending reset link goes too, and that is not scope creep.
   *
   * This control is reached by somebody who believes another person is in their
   * account, and what they are asking for is that the other person be locked out.
   * A live reset token is a credential that grants exactly the way back in they
   * are trying to close: an intruder who started a recovery before being noticed
   * would keep it, walk in afterwards, and the person who pressed this would have
   * been told every session was ended. `/password` already voids them for the
   * narrower reason that the password they were going to change has changed.
   *
   * Inside the transaction, so a rollback cannot leave the tokens voided and the
   * sessions alive, or the reverse.
   */
  await destroyAllSessions(req.user.id, async (client) => {
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

/* -------------------------------------------------------------------------- */
/* Two-step sign-in                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The door every path that checks a *live* factor goes through.
 *
 * Written once for the reason `assertCurrentPassword` is written once: this is
 * the whole security property of four routes, and a three-step sequence spelled
 * out four times is a sequence one of them eventually gets a weaker version of.
 * The step that would go missing is the first one, and it is the one that
 * matters.
 *
 * **Read, compare, charge only on failure, in that order.** Charging successes
 * as `consume` does would lock somebody out of their own account for signing in
 * five times in a quarter of an hour on a flaky connection. Charging failures
 * only with nothing reading first is the exact defect `rateLimit.js` argues
 * about at length: it refuses the wrong guesses and waves the right one through,
 * so a guesser pays nothing for the only attempt they care about.
 *
 * The message is the caller's, because a wrong code at the sign-in form and a
 * wrong code halfway through recovering a lost password are two different
 * situations to be in and deserve two different sentences. What must not vary
 * is the mechanism above it.
 *
 * `/2fa/confirm` is the one path comparing a code that does not come through
 * here, and it is safe: it compares against a secret the caller generated for
 * themselves a moment earlier, so it is an oracle for nothing, and it already
 * sits behind the `confirm:` allowance that `/2fa/enroll` charged.
 */
async function assertFactor({ userId, ip, code, message }) {
  await assertMayUseFactor({ userId, ip })

  if (!(await verifyFactor(userId, code))) {
    await recordFactorFailure({ userId, ip })
    throw new BadRequest(message, 'code')
  }
}

/**
 * What a wrong code is called at the sign-in form, and while recovering.
 *
 * Two sentences rather than one shared string, because the second one is
 * reached by somebody who has already answered their security question and has
 * to be told plainly that this step is not optional. A generic 400 there leaves
 * them retyping an answer they already got right.
 */
const WRONG_CODE =
  'That code is not right. Type the six digit code from your authenticator app, or one of your recovery codes.'
const WRONG_CODE_RECOVERY = `${WRONG_CODE} We cannot skip this step.`

/**
 * What this account's second factor currently is.
 *
 * `enabled` is already on `req.user`, so this endpoint exists for the count
 * rather than for the flag, and the count is the part that has to be said out
 * loud: an account with the factor on and zero unused recovery codes is one lost
 * phone away from needing an operator, and the accepted cost of that is only
 * acceptable if the person can see it coming. The `/2fa` page reads this and
 * says so in the strongest words on the screen when it reaches zero.
 *
 * **The codes themselves are never here.** They are said exactly once, in the
 * response to `/2fa/confirm`, which is the rule `board_shares` follows: a
 * credential that can be asked for again is one the account page hands to
 * anybody holding a session.
 */
authRouter.get('/2fa', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  res.json({
    enabled: req.user.twoFactorEnabled,
    remainingRecoveryCodes: await remainingRecoveryCodes(req.user.id),
  })
})

/**
 * Step one of turning it on: get a secret, and prove nothing yet.
 *
 * **The current password is required, and this is the strongest form of the
 * argument `assertCurrentPassword` already makes.** A session left open on a
 * shared machine must not be enough to change somebody's password, and it must
 * *especially* not be enough to attach an attacker's authenticator to the
 * account, because that is a lockout rather than a nuisance. It also gets the
 * guest refusal and the `confirm:` allowance for free rather than inventing a
 * second version of either.
 *
 * The already-on check runs before the password, which costs nothing and
 * discloses nothing: the caller is holding a session for this account, and
 * `GET /api/auth/me` on that same session already reports `twoFactorEnabled`.
 * Doing it in this order means a request that was always going to be refused
 * does not spend an allowance on a scrypt derivation. `beginEnrollment` guards
 * the same condition inside its own WHERE, which is what actually holds when two
 * requests race; this branch is here for the sentence it gets to say.
 *
 * What comes back is displayed and then, on the next call, thrown away. Nothing
 * is on until `/2fa/confirm` succeeds, so an enrollment somebody starts and
 * abandons leaves a sealed secret that no login path ever reads.
 */
authRouter.post('/2fa/enroll', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  if (req.user.twoFactorEnabled)
    throw new BadRequest('Two-step sign-in is already on for this account.', 'code')

  await assertCurrentPassword(req.user, req.body?.currentPassword)

  const enrollment = await beginEnrollment(req.user.id, req.user.email)
  // Null means the guarded UPDATE matched nothing, so another request confirmed
  // an enrollment between the check above and this statement.
  if (!enrollment)
    throw new BadRequest('Two-step sign-in is already on for this account.', 'code')

  res.json(enrollment)
})

/**
 * Step two: prove the app is really generating this account's codes, and only
 * then turn it on.
 *
 * **This is what prevents enrolling a secret nobody can produce a code from**,
 * which would be a locked account rather than a failed setup. It is also the
 * only path anywhere that writes `totp_confirmed_at`.
 *
 * No current password. The session already proved it one call ago to get the
 * secret, and the secret in this caller's hands is the thing being proved: the
 * code is checked against a secret they generated for themselves a moment
 * earlier, so this is not an oracle for anything. It inherits the `confirm:`
 * allowance the enroll call already charged, which is why it is the one path
 * comparing a code that does not go through the factor limiter.
 *
 * The ten recovery codes come back here and nowhere else, ever.
 */
authRouter.post('/2fa/confirm', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })

  const recoveryCodes = await confirmEnrollment(req.user.id, req.body?.code)
  if (!recoveryCodes)
    throw new BadRequest(
      'That code is not right. Check your authenticator app and try again.',
      'code',
    )

  res.json({ recoveryCodes })
})

/**
 * The two controls that need the password *and* a live factor, and the argument
 * they share.
 *
 * A disable that took only the password would make the whole feature exactly as
 * strong as the password, which is the thing it exists not to be. A fresh set of
 * ten recovery codes is a set of ten new ways into the account, so it is the
 * same act wearing different clothes and it gets the same lock.
 *
 * The password goes first, through `assertCurrentPassword`, so somebody who does
 * not hold the account never reaches the code comparison and never spends its
 * allowance. The "not on" branch goes before both, so an account with no factor
 * is told what is actually true rather than being told its code is wrong about a
 * code nothing could produce.
 */
const assertMayChangeFactor = async (req) => {
  if (!req.user.twoFactorEnabled)
    throw new BadRequest('Two-step sign-in is not on for this account.', 'code')

  await assertCurrentPassword(req.user, req.body?.currentPassword)
  await assertFactor({
    userId: req.user.id,
    ip: req.clientIp,
    code: req.body?.code,
    message: WRONG_CODE,
  })
}

/**
 * Turn the second factor off.
 *
 * **Sessions are deliberately not destroyed, and that follows the rule already
 * in this file rather than inventing one.** `/password` and `/reset` destroy
 * every session because a credential *changed* in a way that might be locking an
 * intruder out; `/claim` deliberately does not, because there was nothing to
 * revoke. Nothing about a live session's authority changes here, the person has
 * just proved both factors on this very request, and `/sessions` is one link
 * away in the account menu for anybody who wants the stronger thing. This is the
 * decision in this feature most worth a second opinion, and it is asserted
 * positively in `twoFactorEnroll.test.js` so reversing it is a deliberate edit
 * to a test rather than a surprise.
 *
 * `disableTwoFactor` does the whole thing in one transaction, so there is no
 * outcome in which the columns are cleared and ten recovery codes are still
 * standing, or a pending challenge outlives the factor it was issued against.
 */
authRouter.post('/2fa/disable', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  await assertMayChangeFactor(req)

  await disableTwoFactor(req.user.id)
  res.json({ ok: true })
})

/**
 * Replace all ten recovery codes.
 *
 * The ten that were there stop working in the same statement the new ten are
 * written by, which is what keeps "how many ways into this account exist" equal
 * to ten rather than growing by ten every time somebody presses the button.
 *
 * Reached by somebody who has spent codes and wants a full set back, and by
 * somebody who thinks the piece of paper has been seen. Both want the old ones
 * dead, and the second one needs that more than they need the new ones.
 */
authRouter.post('/2fa/recovery-codes', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  await assertMayChangeFactor(req)

  res.json({ recoveryCodes: await regenerateRecoveryCodes(req.user.id) })
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
    `SELECT id, security_answer_hash, security_answer_salt, totp_confirmed_at
       FROM users WHERE email = $1`,
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

  /**
   * A correct answer on an account with a second factor buys a challenge, not a
   * reset token.
   *
   * **The factor is demanded here rather than in front of `/auth/reset`**, and
   * that is the load-bearing choice. The reset token *is* the credential:
   * issuing one and then guarding its use would mean the factor is protecting
   * something already handed out, and `POST /api/auth/sessions` deliberately
   * voids pending reset tokens precisely because a live one is a way in.
   * Guarding the issue is fewer moving parts and leaves `/auth/reset` untouched.
   *
   * **The disclosure this accepts, named rather than discovered.** The reply
   * shape now differs for an account with a factor, so somebody can tell that
   * an account has 2FA. That is only visible to somebody who has *already
   * answered the security question correctly*, so it is a leak to somebody
   * holding the secret, and there is no arrangement of this flow that avoids it:
   * the step either issues a token or it does not. `POST /api/auth/forgot`, which
   * anybody who can type an address can reach, is untouched and discloses
   * nothing.
   *
   * All three keys are always present, one of the first two always null. That is
   * the shape `/auth/login` uses and the shape `getShare` uses, and it means the
   * client has one type rather than a union it has to narrow before it can read
   * either branch. `expiresInMinutes` describes the reset token and stays on the
   * response whether or not one came with it, so the page's copy does not have
   * to guard a field that appears and disappears.
   */
  if (user.totp_confirmed_at) {
    return res.json({
      token: null,
      challenge: {
        token: await createChallenge(user.id, 'reset'),
        expiresInMinutes: CHALLENGE_TTL_MINUTES,
      },
      expiresInMinutes: RESET_TTL_MINUTES,
    })
  }

  res.json({
    token: await createResetToken(user.id),
    challenge: null,
    expiresInMinutes: RESET_TTL_MINUTES,
  })
})

/**
 * Step two and a half: the second factor, in exchange for the reset token.
 *
 * Reached only by somebody who has already answered the security question, and
 * it is the step that makes the question survivable as an authenticator. Knowing
 * somebody's first pet stops being sufficient here, which is the entire reason
 * this feature exists.
 *
 * The same door `/login/2fa` uses: the same challenge table, the same claim, the
 * same factor check and the same allowance. What differs is the purpose stamped
 * on the row, compared inside the claiming statement, so a challenge earned here
 * cannot sign anybody in and one earned at the sign-in form cannot buy a reset.
 *
 * **The refusal says what it is refusing.** An account with the factor on, no
 * authenticator and no unused recovery codes can do nothing from this page, and
 * the accepted cost of that is only acceptable if it is said out loud rather
 * than delivered as a generic 400 that leaves somebody retyping an answer they
 * already got right.
 */
authRouter.post('/forgot/2fa', async (req, res) => {
  const userId = await consumeChallenge(req.body?.token, 'reset')
  if (!userId)
    throw new BadRequest(
      'That recovery step has expired or has already been used. Start again from your email address.',
      'token',
    )

  // The same door and the same allowance as `/login/2fa`. Recovery does not get
  // a softer one; it is the path that most needs the harder one.
  await assertFactor({
    userId,
    ip: req.clientIp,
    code: req.body?.code,
    message: WRONG_CODE_RECOVERY,
  })

  res.json({ token: await createResetToken(userId), expiresInMinutes: RESET_TTL_MINUTES })
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

/**
 * Delete the account, and everything saved under it.
 *
 * **This asked for nothing but a session until 2026-07-30, and it was the one
 * door on this router standing open.** `/password` and `/sessions` beside it
 * both go through `assertCurrentPassword` on an argument this file makes at
 * length: a session left open on a shared machine must not be enough, or the
 * control is a gift to the person it exists to protect against. Deletion is
 * strictly worse than either of those, since it destroys every board by cascade
 * with no backup behind it, and it was the only one asking for less.
 *
 * **The factor is required too when there is one, and that is not belt and
 * braces.** A second factor exists so that knowing the password is not enough to
 * reach the account. If the password alone were enough here, somebody holding a
 * stolen session and the password would destroy everything without ever meeting
 * the factor, which is precisely the hole the recovery path was designed around
 * when the factor was put in front of issuing a reset token rather than behind
 * spending one. `assertMayChangeFactor` is deliberately not reused: it refuses an
 * account that has no factor, which is right for turning one off and wrong here,
 * because most accounts have none and all of them may be deleted.
 *
 * **A guest is let through on the session alone, by name rather than by falling
 * through the comparison.** That row has no password, and `verifyPassword`
 * answers false for its null salt by design, so demanding one would not make
 * deletion harder for a guest, it would make it impossible. `PrivacyPolicy.tsx`
 * tells everybody they may withdraw consent by deleting their account and
 * excepts nobody, and the session is the only credential such an account has:
 * whoever holds it already has everything the account can reach, so nothing is
 * escalated by accepting it. Held by `accountDeletion.test.js` (:8819).
 *
 * **It stays a `DELETE` with a body, although `/sessions` argued its way to
 * `POST` partly to avoid exactly that**, and the difference is worth stating
 * because the two look like the same call. That argument had two legs. The first
 * does not apply here: `/sessions` mints a session and sets a cookie, so it is
 * not only a deletion, while this genuinely is one and the collection reading is
 * honest. The second, that clients and intermediaries are careless with a body on
 * a `DELETE`, does apply, but it points the other way once the failure mode is
 * followed through. A body that gets stripped arrives here as no
 * `currentPassword` at all, which is a 400 and an account that still exists.
 * `/sessions` could not afford that risk because there the same accident would
 * have left a destructive endpoint reachable on a session alone; here it fails
 * closed, and the cost is somebody being unable to delete their account rather
 * than somebody else being able to.
 */
authRouter.delete('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })

  if (!req.user.isGuest) {
    await assertCurrentPassword(req.user, req.body?.currentPassword)
    if (req.user.twoFactorEnabled)
      await assertFactor({
        userId: req.user.id,
        ip: req.clientIp,
        code: req.body?.code,
        message: WRONG_CODE,
      })
  }

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
  await destroyAllSessions(req.user.id)
  await run('DELETE FROM users WHERE id = $1', req.user.id)
  signOut(res)
  res.status(204).end()
})
