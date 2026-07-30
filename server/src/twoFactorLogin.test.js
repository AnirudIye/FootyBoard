import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, get, all, closePool } from './db.js'
import { createSession, hashPassword, COOKIE_NAME } from './auth.js'
import { hashAnswer } from './securityQuestions.js'
import { addressKey, answerKey, factorKey } from './rateLimit.js'
import { codeForStep, stepAt } from './totp.js'
import { createChallenge } from './twoFactor.js'

/**
 * The second step of signing in, and the second step of recovering an account.
 *
 * The assertion this whole file exists for is that **no session is minted
 * between the password and the code**. Everything else here is a way of getting
 * that wrong: a challenge that can be spent twice, a code that can be replayed
 * inside the ninety seconds it is live, a challenge issued by the recovery flow
 * being spendable at the sign-in form, or a limiter that turns away the wrong
 * guesses and waves the right one through.
 *
 * **Every test that deliberately exhausts a factor allowance lives here**, and
 * that is a rule rather than a coincidence. `factor-ip:` is one row, and two
 * concurrent files spending it produce a 429 in whichever one asks next, which
 * reads exactly like a broken limiter and is how an afternoon disappears.
 * `twoFactorEnroll.test.js` keeps its wrong-code counts in single digits for the
 * same reason.
 */

/**
 * Its own port. Every number below this one is spoken for, the last of them by
 * the enrollment suite this file is split from. Neighbouring suites are named by
 * file rather than by port number throughout this file, so that grepping the
 * tree for a port still answers "which one file claims it".
 */
const PORT = 8818
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/**
 * This suite's own network. See the note in `twoFactorEnroll.test.js`: without
 * a declared proxy and an `X-Forwarded-For` of its own, every per-IP allowance
 * is one row shared by every file running concurrently. TEST-NET-3 is reserved
 * for documentation so it can never be a real client, and .218 is deliberately
 * above the range `rateLimit.test.js` writes into and clear of .7 and .15.
 */
const SUITE_IP = '203.0.113.218'

let child
const users = []
const emails = []

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`instance on :${PORT} never became healthy`)
}

/**
 * Every per-IP allowance this suite spends, named one at a time and never swept
 * by prefix. A `LIKE 'factor-ip:%'` would reach into whichever neighbour is
 * mid-count, which is a live defect in two existing files and not one to copy.
 */
const IP_KEYS = [
  `ip:${SUITE_IP}`,
  `factor-ip:${SUITE_IP}`,
  `answer-ip:${SUITE_IP}`,
  `forgot-ip:${SUITE_IP}`,
  `reset-ip:${SUITE_IP}`,
]

const clearIpAllowances = async () => {
  for (const key of IP_KEYS) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

const call = (path, init = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: {
      'X-Forwarded-For': SUITE_IP,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const post = (path, body, headers) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers })

/** Status, parsed body, raw text, the session cookie, and every cookie set. */
const read = async (res) => {
  const text = await res.text()
  const cookies = res.headers.getSetCookie()
  return {
    status: res.status,
    text,
    body: text ? JSON.parse(text) : null,
    cookies,
    cookie: cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))?.split(';')[0] ?? null,
  }
}

function freshEmail() {
  const email = `${randomUUID()}@test.invalid`
  emails.push(email)
  return email
}

async function makeUser(password = 'the-only-password', answer = 'Blue Sky') {
  const id = randomUUID()
  const email = freshEmail()
  const digest = await hashPassword(password)
  const answerDigest = await hashAnswer(answer)
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        display_name, security_question_id, security_answer_hash,
                        security_answer_salt)
     VALUES ($1, $2, $3, $4, $5, $5, 'Login Tester', 'first-pet', $6, $7)`,
    id,
    email,
    digest.hash,
    digest.salt,
    new Date().toISOString(),
    answerDigest.hash,
    answerDigest.salt,
  )
  users.push(id)
  return { id, email, password, answer }
}

const liveSessions = async (userId) =>
  (await all('SELECT id FROM sessions WHERE user_id = $1', userId)).length

// Through `factorKey` rather than spelling the prefix again here: a test that
// names the key its own way is a test that can pass while the limiter writes
// somewhere else entirely.
const factorAllowance = (userId) =>
  get('SELECT count, locked_until FROM login_attempts WHERE key = $1', factorKey(userId))

/** The code the account's authenticator would show at a given step. */
const codeAt = (secret, offset = 0) => codeForStep(secret, stepAt() + offset)

/**
 * Turn the factor on for an account, through the real endpoints.
 *
 * Driven over HTTP rather than by calling `twoFactor.js` in this process, so
 * nothing here rests on the test process and the spawned instance deriving the
 * same encryption key from the same absent `SESSION_SECRET`.
 */
async function enable(person) {
  const cookie = `${COOKIE_NAME}=${await createSession(person.id)}`
  const begun = await read(
    await post('/auth/2fa/enroll', { currentPassword: person.password }, { Cookie: cookie }),
  )
  assert.equal(begun.status, 200, begun.text)
  const done = await read(
    await post('/auth/2fa/confirm', { code: codeAt(begun.body.secret) }, { Cookie: cookie }),
  )
  assert.equal(done.status, 200, done.text)
  // The enrolling session is thrown away: every test below signs in from
  // scratch, and a live session lying about would hide a missing cookie.
  await run('DELETE FROM sessions WHERE user_id = $1', person.id)
  return { secret: begun.body.secret, codes: done.body.recoveryCodes }
}

before(async () => {
  await migrate()
  await clearIpAllowances()

  child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${PORT}`,
      // Without this `req.ip` is the socket address and every suite shares it.
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    if (!text.includes('ENCRYPTION_KEY')) process.stderr.write(`[${PORT}] ${text}`)
  })
  await waitForHealth()
})

beforeEach(clearIpAllowances)

after(async () => {
  child?.kill()
  for (const id of users) {
    for (const key of [`confirm:${id}`, factorKey(id)]) {
      await run('DELETE FROM login_attempts WHERE key = $1', key)
    }
    await run('DELETE FROM users WHERE id = $1', id)
  }
  for (const email of emails) {
    for (const key of [`account:${email}`, answerKey(email), addressKey('forgot', email)]) {
      await run('DELETE FROM login_attempts WHERE key = $1', key)
    }
  }
  await clearIpAllowances()
  await closePool()
})

/* -------------------------------------------------------------------------- */
/* Signing in                                                                  */
/* -------------------------------------------------------------------------- */

test('an account with no factor signs in exactly as it always did', async () => {
  const person = await makeUser()

  const res = await read(await post('/auth/login', { email: person.email, password: person.password }))

  assert.equal(res.status, 200, res.text)
  // Both keys always present and exactly one of them null, which is the shape
  // `getShare` already uses. A discriminated union would read worse and would
  // not survive `const { user } = await api.logIn(...)` on the client.
  assert.equal(res.body.user.id, person.id)
  assert.equal(res.body.challenge, null)
  assert.ok(res.cookie, 'no session cookie for an account with no factor')
  assert.equal(await liveSessions(person.id), 1)
})

test('an account with a factor gets a challenge and no session at all', async () => {
  const person = await makeUser()
  await enable(person)
  assert.equal(await liveSessions(person.id), 0)

  const res = await read(await post('/auth/login', { email: person.email, password: person.password }))

  /**
   * The single most important assertion in this feature.
   *
   * A correct password buys a five minute challenge and nothing else. If a
   * session were minted here the second factor would be decorative: whoever
   * knows the password is already signed in, and the code is a form they can
   * close. `signIn` and `createSession` must not be reachable from this branch.
   */
  assert.equal(res.status, 200, res.text)
  assert.equal(res.cookie, null, `a session cookie was minted before the code was checked`)
  assert.equal(await liveSessions(person.id), 0, 'a session row exists between the two steps')
  assert.equal(res.body.user, null, 'a user came back before the code was checked')

  assert.equal(typeof res.body.challenge.token, 'string')
  assert.equal(res.body.challenge.expiresInMinutes, 5)

  /**
   * And it is in the body rather than in *any* cookie, which is the other half
   * of "this is not a session". A cookie would ride on every request to the API,
   * including the board routes, so one handler that forgot to distinguish the
   * two would be an authentication bypass. In the body it exists only in the
   * JavaScript memory of the page asking for the code.
   */
  assert.deepEqual(res.cookies, [], `something was set as a cookie: ${res.cookies.join(' | ')}`)
})

test('the code completes the sign-in, and only then', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const first = await read(await post('/auth/login', { email: person.email, password: person.password }))
  const token = first.body.challenge.token

  const wrong = await read(await post('/auth/login/2fa', { token, code: '000000' }))
  assert.equal(wrong.status, 400, wrong.text)
  assert.equal(wrong.body.field, 'code')
  assert.equal(wrong.cookie, null, 'a wrong code minted a session')
  assert.equal(await liveSessions(person.id), 0)

  /**
   * And the challenge is spent by the attempt whether or not the code was
   * right, because it is claimed before the code is compared. That is a cost
   * paid deliberately: it means one challenge buys exactly one guess, so the
   * five-per-fifteen-minutes allowance cannot be spread across an unlimited
   * number of tries against a single password entry. Somebody who mistypes has
   * to enter their password again, which is the correct price for a step that
   * is guarding the account against whoever already knows it.
   */
  const retried = await read(await post('/auth/login/2fa', { token, code: codeAt(secret, 1) }))
  assert.equal(retried.status, 400, 'a spent challenge accepted a second attempt')
  assert.equal(retried.cookie, null)

  const second = await read(
    await post('/auth/login', { email: person.email, password: person.password }),
  )
  const done = await read(
    await post('/auth/login/2fa', { token: second.body.challenge.token, code: codeAt(secret, 1) }),
  )
  assert.equal(done.status, 200, done.text)
  assert.equal(done.body.user.id, person.id)
  assert.equal(done.body.user.twoFactorEnabled, true)
  assert.ok(done.cookie, 'no session cookie after the code was accepted')
  assert.equal(await liveSessions(person.id), 1)

  // And it is a session in full, not merely a cookie in a header.
  const me = await read(await call('/auth/me', { headers: { Cookie: done.cookie } }))
  assert.equal(me.status, 200, me.text)
  assert.equal(me.body.user.id, person.id)
})

test('a challenge is spent once, and a code cannot be replayed inside its window', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const first = await read(await post('/auth/login', { email: person.email, password: person.password }))
  const code = codeAt(secret, 1)
  const done = await read(await post('/auth/login/2fa', { token: first.body.challenge.token, code }))
  assert.equal(done.status, 200, done.text)

  // The same challenge again, with a code that is still live.
  const reused = await read(
    await post('/auth/login/2fa', { token: first.body.challenge.token, code: codeAt(secret, 1) }),
  )
  assert.equal(reused.status, 400, reused.text)
  assert.equal(reused.cookie, null, 'a spent challenge minted a session')
  assert.equal(await liveSessions(person.id), 1, 'a spent challenge minted a session row')

  /**
   * And the same *code* on a brand new challenge is refused, which is the
   * replay the ninety second window actually exposes: somebody who reads a code
   * over a shoulder, or lifts one off a phished form, has that long to use it.
   * `totp_last_step` is claimed in one statement rather than read and judged, so
   * two requests carrying the same code cannot both pass.
   */
  const second = await read(
    await post('/auth/login', { email: person.email, password: person.password }),
  )
  const replay = await read(
    await post('/auth/login/2fa', { token: second.body.challenge.token, code }),
  )
  assert.equal(replay.status, 400, replay.text)
  assert.equal(replay.cookie, null, 'a replayed code minted a session')
  assert.equal(await liveSessions(person.id), 1)
})

test('a recovery code works here, once', async () => {
  const person = await makeUser()
  const { codes } = await enable(person)

  const first = await read(await post('/auth/login', { email: person.email, password: person.password }))
  const done = await read(
    await post('/auth/login/2fa', { token: first.body.challenge.token, code: codes[0] }),
  )
  assert.equal(done.status, 200, done.text)
  assert.ok(done.cookie)

  // One field takes both shapes, because six digits and sixteen letters are
  // unambiguous and a mode toggle would be one more thing to get wrong while
  // locked out.
  const second = await read(
    await post('/auth/login', { email: person.email, password: person.password }),
  )
  const again = await read(
    await post('/auth/login/2fa', { token: second.body.challenge.token, code: codes[0] }),
  )
  assert.equal(again.status, 400, again.text)
  assert.equal(again.cookie, null, 'a recovery code was spent twice')

  const remaining = await get(
    'SELECT COUNT(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    person.id,
  )
  assert.equal(remaining.n, 9)
})

test('a challenge from the recovery flow cannot sign anybody in', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const asked = await read(await post('/auth/forgot', { email: person.email }))
  assert.equal(asked.status, 200, asked.text)
  const verified = await read(
    await post('/auth/forgot/verify', { email: person.email, answer: person.answer }),
  )
  assert.equal(verified.status, 200, verified.text)

  /**
   * Purpose is compared in the same statement that claims the row. Without it a
   * factor met on the recovery path would be spendable at the sign-in form, so
   * the second factor would be proved once and reused to buy a different
   * privilege.
   */
  const res = await read(
    await post('/auth/login/2fa', {
      token: verified.body.challenge.token,
      code: codeAt(secret, 1),
    }),
  )
  assert.equal(res.status, 400, res.text)
  assert.equal(res.cookie, null, 'a reset challenge signed somebody in')
  assert.equal(await liveSessions(person.id), 0)
})

test('an expired challenge is refused', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const first = await read(await post('/auth/login', { email: person.email, password: person.password }))
  // Aged directly rather than by waiting five minutes.
  await run(
    'UPDATE auth_challenges SET expires_at = $1 WHERE user_id = $2 AND used_at IS NULL',
    Date.now() - 1000,
    person.id,
  )

  const res = await read(
    await post('/auth/login/2fa', { token: first.body.challenge.token, code: codeAt(secret, 1) }),
  )
  assert.equal(res.status, 400, res.text)
  assert.equal(res.cookie, null, 'an expired challenge minted a session')
  assert.equal(await liveSessions(person.id), 0)
})

test('a token that never existed is refused, and says nothing about why', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const real = await read(await post('/auth/login', { email: person.email, password: person.password }))
  const spent = await read(
    await post('/auth/login/2fa', { token: real.body.challenge.token, code: codeAt(secret, 1) }),
  )
  assert.equal(spent.status, 200, spent.text)

  const invented = await read(await post('/auth/login/2fa', { token: 'not-a-token', code: '000000' }))
  const replayed = await read(
    await post('/auth/login/2fa', { token: real.body.challenge.token, code: '000000' }),
  )
  const missing = await read(await post('/auth/login/2fa', { code: '000000' }))

  // One message and one status for a token that never existed, one already
  // spent, and one absent, exactly as `/auth/reset` does.
  assert.equal(invented.status, 400)
  assert.equal(replayed.status, invented.status)
  assert.equal(missing.status, invented.status)
  assert.equal(replayed.body.error, invented.body.error)
  assert.equal(missing.body.error, invented.body.error)
})

test('the password allowance is still handed back by a correct password', async () => {
  const person = await makeUser()
  await enable(person)

  // Long enough to reach the limiter: a password under the eight character
  // minimum is refused by `validatePassword` before anything is counted.
  const refused = await read(
    await post('/auth/login', { email: person.email, password: 'not-the-password' }),
  )
  assert.equal(refused.status, 401, refused.text)
  assert.equal(
    (await get('SELECT count FROM login_attempts WHERE key = $1', `account:${person.email}`)).count,
    1,
  )

  // `assertMayAttempt` refuses two sign-ins less than half a second apart, so
  // the row is aged rather than the test sleeping through it.
  await run(
    'UPDATE login_attempts SET last_attempt = $1 WHERE key = $2',
    Date.now() - 5000,
    `account:${person.email}`,
  )

  const res = await read(await post('/auth/login', { email: person.email, password: person.password }))
  assert.equal(res.status, 200, res.text)
  assert.ok(res.body.challenge)

  /**
   * `clearFailures` still runs on a correct password even though no session is
   * minted, because that allowance guards the password and the password was
   * right. The factor has its own keys, which is the rule the security answer
   * already follows: burning one allowance must not shut a door it does not
   * guard.
   */
  assert.equal(await get('SELECT count FROM login_attempts WHERE key = $1', `account:${person.email}`), null)
  assert.equal(await factorAllowance(person.id), null, 'the password path charged the factor')
})

test('wrong codes lock the account, and the lock holds against a correct one', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  /**
   * Twenty together rather than five in turn, which is the shape the limiter
   * this repo used to have could not survive: every caller read a count of zero
   * and wrote one, so an allowance of five never fired however hard it was hit.
   * Spread across the cluster these would be several processes writing one row.
   *
   * Each attempt gets its own challenge, because one challenge buys exactly one
   * guess. They are minted directly rather than through twenty sign-ins, so this
   * test is about the code allowance and not about twenty scrypt derivations.
   */
  const tokens = await Promise.all(
    Array.from({ length: 20 }, () => createChallenge(person.id, 'login')),
  )
  const results = await Promise.all(
    tokens.map(async (token) => read(await post('/auth/login/2fa', { token, code: '000000' }))),
  )
  assert.ok(
    results.every((r) => r.status === 400 || r.status === 429),
    'something other than a refusal came back',
  )
  assert.ok(results.every((r) => r.cookie === null), 'a wrong code minted a session')
  assert.equal(await liveSessions(person.id), 0)

  const locked = await factorAllowance(person.id)
  assert.ok(locked, 'nothing was counted at all')
  assert.ok(locked.count >= 5, `the count is ${locked.count}, not an increment`)
  assert.ok(Number(locked.locked_until) > Date.now(), 'the account is not locked')

  // The per-IP allowance is spent too. Clearing it means the refusal below can
  // only be coming from the per-account lock, which is what is under test.
  await clearIpAllowances()

  /**
   * And the **correct** code is refused, which is the half a limiter charged
   * only on the failure path would get wrong: with no read in front of it, the
   * wrong guesses are turned away and the right one is waved through, so a
   * guesser pays nothing for the only attempt they care about. For a six digit
   * code that is not a subtlety, it is the whole feature. Same shape as
   * `passwordRecovery.test.js`'s assertion about the security answer.
   */
  const token = await createChallenge(person.id, 'login')
  const correct = await read(await post('/auth/login/2fa', { token, code: codeAt(secret, 1) }))

  assert.equal(correct.status, 429, 'the lock did not hold against a correct code')
  assert.equal(correct.cookie, null, 'a locked account was signed in anyway')
  assert.equal(await liveSessions(person.id), 0)
  assert.match(correct.body.error, /incorrect codes/i)

  // Being refused leaves the row alone, so retrying does not push the moment it
  // expires out in front of the caller.
  const held = await factorAllowance(person.id)
  assert.equal(held.count, locked.count)
  assert.equal(Number(held.locked_until), Number(locked.locked_until))
})

test('the factor allowance and the password allowance do not shut each other', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const tokens = await Promise.all(
    Array.from({ length: 6 }, () => createChallenge(person.id, 'login')),
  )
  for (const token of tokens) await post('/auth/login/2fa', { token, code: '000000' })
  assert.ok(Number((await factorAllowance(person.id)).locked_until) > Date.now())

  await clearIpAllowances()

  /**
   * Burning the factor allowance must not shut the sign-in door, and the
   * reverse, which is the rule `answer:` and `account:` already follow. The
   * password step still answers, and it is the code step that refuses.
   */
  const res = await read(
    await post('/auth/login', { email: person.email, password: person.password }),
  )
  assert.equal(res.status, 200, res.text)
  assert.ok(res.body.challenge, 'a spent factor allowance blocked the password step')
  assert.equal(res.cookie, null)

  const blocked = await read(
    await post('/auth/login/2fa', { token: res.body.challenge.token, code: codeAt(secret, 1) }),
  )
  assert.equal(blocked.status, 429, blocked.text)
})

/* -------------------------------------------------------------------------- */
/* Recovering an account                                                       */
/* -------------------------------------------------------------------------- */

test('an account with no factor recovers exactly as it always did', async () => {
  const person = await makeUser()

  const verified = await read(
    await post('/auth/forgot/verify', { email: person.email, answer: person.answer }),
  )
  assert.equal(verified.status, 200, verified.text)
  // This is the regression guard for `passwordRecovery.test.js` on :8804: if the
  // branch fires for an account with no factor, that suite fails and the change
  // is wrong.
  assert.equal(typeof verified.body.token, 'string')
  assert.equal(verified.body.expiresInMinutes, 15)
  assert.equal(verified.body.challenge, null)

  const done = await read(
    await post('/auth/reset', { token: verified.body.token, password: 'a-brand-new-password' }),
  )
  assert.equal(done.status, 200, done.text)
})

test('an account with a factor gets a challenge instead of a reset token', async () => {
  const person = await makeUser()
  await enable(person)

  const verified = await read(
    await post('/auth/forgot/verify', { email: person.email, answer: person.answer }),
  )
  assert.equal(verified.status, 200, verified.text)

  /**
   * The factor is demanded here, before a reset token exists at all, rather than
   * in front of `/auth/reset`. The reset token *is* the credential: issuing one
   * and then guarding its use means the factor is protecting something already
   * handed out, and `POST /api/auth/sessions` deliberately voids pending reset
   * tokens precisely because a live one is a way in.
   */
  assert.equal(verified.body.token, null, 'a reset token was issued before the code')
  assert.equal(typeof verified.body.challenge.token, 'string')
  assert.equal(verified.body.challenge.expiresInMinutes, 5)

  // And the challenge is not a reset token wearing a different name.
  const misused = await read(
    await post('/auth/reset', {
      token: verified.body.challenge.token,
      password: 'a-brand-new-password',
    }),
  )
  assert.equal(misused.status, 400, misused.text)
  assert.equal(misused.body.field, 'token')
})

test('the code buys the reset token, and a wrong one buys nothing', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const first = await read(
    await post('/auth/forgot/verify', { email: person.email, answer: person.answer }),
  )
  const wrong = await read(
    await post('/auth/forgot/2fa', { token: first.body.challenge.token, code: '000000' }),
  )
  assert.equal(wrong.status, 400, wrong.text)
  assert.equal(wrong.body.token, undefined, 'a wrong code produced a reset token')
  /**
   * The wording is asserted, not just the status. An account with the factor on,
   * no authenticator and no unused codes can do nothing from this page, and the
   * plan's requirement is that this is *said* rather than falling through to a
   * generic 400 that leaves somebody retyping an answer they already got right.
   */
  assert.match(wrong.body.error, /recovery code/i)

  const second = await read(
    await post('/auth/forgot/verify', { email: person.email, answer: person.answer }),
  )
  const done = await read(
    await post('/auth/forgot/2fa', {
      token: second.body.challenge.token,
      code: codeAt(secret, 1),
    }),
  )
  assert.equal(done.status, 200, done.text)
  assert.equal(typeof done.body.token, 'string')
  assert.equal(done.body.expiresInMinutes, 15)

  const reset = await read(
    await post('/auth/reset', { token: done.body.token, password: 'a-brand-new-password' }),
  )
  assert.equal(reset.status, 200, reset.text)
})

test('a sign-in challenge cannot buy a reset token', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const login = await read(
    await post('/auth/login', { email: person.email, password: person.password }),
  )

  const res = await read(
    await post('/auth/forgot/2fa', {
      token: login.body.challenge.token,
      code: codeAt(secret, 1),
    }),
  )
  assert.equal(res.status, 400, res.text)
  assert.equal(res.body.token, undefined, 'a login challenge produced a reset token')
})

test('a completed reset does not turn the factor off', async () => {
  const person = await makeUser()
  const { secret } = await enable(person)

  const verified = await read(
    await post('/auth/forgot/verify', { email: person.email, answer: person.answer }),
  )
  const exchanged = await read(
    await post('/auth/forgot/2fa', {
      token: verified.body.challenge.token,
      code: codeAt(secret, 1),
    }),
  )
  const done = await read(
    await post('/auth/reset', { token: exchanged.body.token, password: 'a-brand-new-password' }),
  )
  assert.equal(done.status, 200, done.text)

  /**
   * If a reset cleared the factor, the recovery path would be a factor-removal
   * path and the whole feature would be worth exactly the security question,
   * which is the thing it exists not to be.
   */
  const row = await get(
    'SELECT totp_secret, totp_confirmed_at FROM users WHERE id = $1',
    person.id,
  )
  assert.ok(row.totp_confirmed_at, 'the reset turned the factor off')
  assert.ok(row.totp_secret, 'the reset cleared the secret')
  assert.equal(
    (await get('SELECT COUNT(*)::int AS n FROM recovery_codes WHERE user_id = $1', person.id)).n,
    10,
    'the reset cleared the recovery codes',
  )

  // And signing in with the new password still demands a code.
  const back = await read(
    await post('/auth/login', { email: person.email, password: 'a-brand-new-password' }),
  )
  assert.equal(back.status, 200, back.text)
  assert.equal(back.cookie, null, 'a reset password signed straight in')
  assert.equal(back.body.user, null)
  assert.ok(back.body.challenge.token)
})
