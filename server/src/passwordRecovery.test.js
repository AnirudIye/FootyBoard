import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, get, all, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { hashAnswer } from './securityQuestions.js'
import { answerKey, addressKey } from './rateLimit.js'

/**
 * Recovering a password by answering a security question, end to end.
 *
 * There is no email in this flow any more, so the question is the entire
 * authenticator and the things worth asserting are the ones that make a short,
 * guessable secret safe to put a password behind:
 *
 *   - the answer is never stored in a form anything can read;
 *   - the normalisation applied when it is set is the one applied when it is
 *     checked, which is the failure that would be silent and total;
 *   - guessing is rate limited, and the limit holds when the allowance is spent
 *     all at once rather than in turn, which is the shape the old
 *     read-then-write limiter could not survive;
 *   - answering correctly does not hand the allowance back;
 *   - and asking which question guards an address never reveals whether that
 *     address has an account.
 *
 * Against a real Postgres and a real instance, because every one of those is a
 * property of the database statement or the route rather than of a function.
 */

/**
 * Its own port. `node --test` runs files concurrently and :8799 to :8803 are
 * already spoken for: the sharing suite takes two, the consent suite one, and
 * the anonymous presence suite two. Landing on one of those does not fail
 * loudly, which is the trap. The instance this file spawns dies of EADDRINUSE
 * and the requests below are answered perfectly well by the other suite's
 * process, until that suite finishes and kills it mid-run.
 */
const PORT = 8804
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
const users = []
const emails = []

/**
 * Every per-IP allowance this suite spends, cleared between tests.
 *
 * These are rows, and rows outlive a test run: a second run would otherwise
 * start partway through the allowance and collect a surprise 429 that reads
 * like a broken limiter. Named exactly rather than swept by prefix, because
 * something else is using this database.
 */
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown']
const IP_KEYS = ['signup', 'forgot-ip', 'answer-ip', 'reset-ip', 'ip'].flatMap((prefix) =>
  LOOPBACK.map((ip) => `${prefix}:${ip}`),
)

const clearIpAllowances = async () => {
  for (const key of IP_KEYS) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

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
 * The per-IP signup allowance is shared with every other suite, so no suite may
 * assume it owns it.
 *
 * `node --test` runs these files concurrently and they all reach the API from
 * 127.0.0.1, so `signup:127.0.0.1` is one counter for the whole run. Between
 * them the suites make more than the ten requests an hour that allowance
 * permits, which made the full suite fail on whichever file happened to ask
 * eleventh while every file passed on its own. Clearing in `before()` cannot fix
 * that: the total is still over the limit, the clear just moves which test loses.
 *
 * So the allowance is reset immediately before each request that spends it.
 * These tests are about what recovery does, not about the limiter, and the
 * suite that *is* about the limiter has its own keys.
 *
 * **Scoped to the loopback addresses this suite actually reaches the API from**,
 * which `IP_KEYS` above already enumerates, rather than the `LIKE 'signup:%'`
 * this used to be. That wildcard reached every other suite's signup counter,
 * which is the same defect `guestJoin` and `displayName` carried against
 * `join:%`: it wiped a neighbour's allowance mid-count and made the file that
 * asserts *when* a limiter trips fail perhaps half the time. Nothing here needs
 * a prefix; this file's own keys are known exactly.
 */
const freshSignupAllowance = async () => {
  for (const ip of LOOPBACK) await run('DELETE FROM login_attempts WHERE key = $1', `signup:${ip}`)
}

/** Paths whose handlers charge that allowance. */
const SPENDS_ALLOWANCE = ['/auth/signup', '/auth/claim']

const call = async (path, init = {}) => {
  if (SPENDS_ALLOWANCE.includes(path)) await freshSignupAllowance()
  return fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

const post = (path, body, headers) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers })

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) })

/** A fresh address, remembered so its allowance rows can be cleared afterwards. */
function freshEmail() {
  const email = `${randomUUID()}@test.invalid`
  emails.push(email)
  return email
}

const sessionCookie = (res) => {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))
  return set ? set.split(';')[0] : null
}

/**
 * A user with a known password and a known answer, made directly rather than
 * through `/signup`, so tests that are not about signing up do not spend that
 * route's per-IP allowance.
 */
async function makeUser({ answer = 'Blue Sky', questionId = 'first-pet' } = {}) {
  const id = randomUUID()
  const email = freshEmail()
  const digest = answer === null ? null : await hashAnswer(answer)
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        security_question_id, security_answer_hash, security_answer_salt)
     VALUES ($1, $2, 'x', 'x', $3, $3, $4, $5, $6)`,
    id,
    email,
    new Date().toISOString(),
    digest ? questionId : null,
    digest?.hash ?? null,
    digest?.salt ?? null,
  )
  users.push(id)
  return { id, email, answer }
}

const accountAllowance = (email) =>
  get('SELECT count, locked_until FROM login_attempts WHERE key = $1', answerKey(email))

before(async () => {
  await migrate()
  await clearIpAllowances()

  child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${PORT}`,
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
  for (const id of users) await run('DELETE FROM users WHERE id = $1', id)
  for (const email of emails) {
    for (const key of [answerKey(email), addressKey('forgot', email), `account:${email}`]) {
      await run('DELETE FROM login_attempts WHERE key = $1', key)
    }
  }
  await clearIpAllowances()
  await closePool()
})

test('the question list is served, and is the one the server validates against', async () => {
  const { status, body } = await json(await call('/auth/security-questions'))

  assert.equal(status, 200)
  assert.ok(Array.isArray(body.questions))
  assert.ok(body.questions.length >= 8)
  for (const q of body.questions) {
    assert.equal(typeof q.id, 'string')
    assert.equal(typeof q.label, 'string')
  }

  // The client builds its dropdown from this, so an id it offers has to be one
  // signup accepts. Anything not on it is a 400 rather than a stored value.
  const rejected = await json(
    await post('/auth/signup', {
      displayName: 'Recovery Tester',
      email: freshEmail(),
      password: 'a-long-enough-password',
      acceptedTerms: true,
      securityQuestionId: 'not-on-the-list',
      securityAnswer: 'Blue Sky',
    }),
  )
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.field, 'securityQuestionId')
})

test('signing up stores the answer hashed, and the answer appears nowhere in the row', async () => {
  const email = freshEmail()
  const answer = 'Kevin Keegan'

  const { status, body } = await json(
    await post('/auth/signup', {
      displayName: 'Recovery Tester',
      email,
      password: 'a-long-enough-password',
      acceptedTerms: true,
      securityQuestionId: 'first-pet',
      securityAnswer: answer,
    }),
  )
  assert.equal(status, 201)
  users.push(body.user.id)

  const row = await get('SELECT * FROM users WHERE email = $1', email)
  const stored = JSON.stringify(row).toLowerCase()

  assert.ok(!stored.includes('kevin'), 'the answer is in the users row in readable form')
  assert.ok(!stored.includes('keegan'))
  assert.ok(!stored.includes('kevin keegan'))

  // The question id is not a secret and is stored plain; the answer is neither.
  assert.equal(row.security_question_id, 'first-pet')
  assert.match(row.security_answer_hash, /^[0-9a-f]{128}$/)
  assert.match(row.security_answer_salt, /^[0-9a-f]{32}$/)
})

test('signup refuses a missing or too-short answer, and writes nothing', async () => {
  for (const [payload, field] of [
    [{ securityAnswer: 'Blue Sky' }, 'securityQuestionId'],
    [{ securityQuestionId: 'first-pet' }, 'securityAnswer'],
    [{ securityQuestionId: 'first-pet', securityAnswer: '  a  ' }, 'securityAnswer'],
    [{ securityQuestionId: 'first-pet', securityAnswer: '      ' }, 'securityAnswer'],
  ]) {
    const email = freshEmail()
    const { status, body } = await json(
      await post('/auth/signup', {
        displayName: 'Recovery Tester',
        email,
        password: 'a-long-enough-password',
        acceptedTerms: true,
        ...payload,
      }),
    )
    assert.equal(status, 400, `${JSON.stringify(payload)} was accepted`)
    assert.equal(body.field, field)
    assert.equal(await get('SELECT id FROM users WHERE email = $1', email), null)
  }
})

test('the round trip: sign up, answer it typed differently, set a new password', async () => {
  const email = freshEmail()

  const created = await json(
    await post('/auth/signup', {
      displayName: 'Recovery Tester',
      email,
      password: 'the-first-password',
      acceptedTerms: true,
      securityQuestionId: 'first-club',
      // Set with padding and capitals, answered later with neither.
      securityAnswer: ' Blue  Sky ',
    }),
  )
  assert.equal(created.status, 201)
  users.push(created.body.user.id)

  const asked = await json(await post('/auth/forgot', { email }))
  assert.equal(asked.status, 200)
  assert.equal(asked.body.question.id, 'first-club')
  assert.ok(asked.body.question.label.length > 0)

  const verified = await json(await post('/auth/forgot/verify', { email, answer: 'blue sky' }))
  assert.equal(verified.status, 200, 'the normalisation at set time and at verify time disagree')
  assert.equal(typeof verified.body.token, 'string')
  assert.equal(verified.body.expiresInMinutes, 15)

  const done = await json(
    await post('/auth/reset', { token: verified.body.token, password: 'the-second-password' }),
  )
  assert.equal(done.status, 200)

  const back = await json(await post('/auth/login', { email, password: 'the-second-password' }))
  assert.equal(back.status, 200, 'the new password does not work')
})

test('a wrong answer is refused, and says nothing about why', async () => {
  const user = await makeUser({ answer: 'Blue Sky' })

  const wrong = await json(await post('/auth/forgot/verify', { email: user.email, answer: 'red sky' }))
  assert.equal(wrong.status, 400)
  assert.equal(wrong.body.token, undefined, 'a token came back for a wrong answer')

  // An address nobody has, and an account from before this feature existed,
  // both fail in exactly the same words.
  const stranger = freshEmail()
  const unknown = await json(await post('/auth/forgot/verify', { email: stranger, answer: 'red sky' }))
  const legacy = await makeUser({ answer: null })
  const noQuestion = await json(
    await post('/auth/forgot/verify', { email: legacy.email, answer: 'red sky' }),
  )

  assert.equal(unknown.status, wrong.status)
  assert.equal(noQuestion.status, wrong.status)
  assert.equal(unknown.body.error, wrong.body.error)
  assert.equal(noQuestion.body.error, wrong.body.error)
})

test('five wrong answers lock the address, even spent all at once', async () => {
  const user = await makeUser({ answer: 'Blue Sky' })

  /**
   * Twenty together rather than five in turn. This is the shape the limiter
   * this repo used to have could not survive: every caller read a count of
   * zero and wrote one, so an allowance of five never fired however hard it
   * was hit. Spread across the cluster these would be three processes writing
   * one row.
   */
  const results = await Promise.all(
    Array.from({ length: 20 }, async () =>
      json(await post('/auth/forgot/verify', { email: user.email, answer: 'wrong' })),
    ),
  )
  assert.ok(
    results.every((r) => r.status === 400 || r.status === 429),
    'something other than a refusal came back',
  )

  const locked = await accountAllowance(user.email)
  assert.ok(locked, 'nothing was counted at all')
  assert.ok(locked.count >= 5, `the count is ${locked.count}, not an increment`)
  assert.ok(Number(locked.locked_until) > Date.now(), 'the address is not locked')

  // The per-IP allowance is spent too. Clearing it means the refusals below can
  // only be coming from the per-account lock, which is what is under test.
  await clearIpAllowances()

  const again = await json(await post('/auth/forgot/verify', { email: user.email, answer: 'wrong' }))
  assert.equal(again.status, 429)
  assert.match(again.body.error, /incorrect answers/i)

  /**
   * And the *correct* answer is refused too, which is the half a limiter
   * charged only on the failure path would get wrong: with no read in front of
   * it, wrong guesses would be turned away and the right one waved through, so
   * a guesser would pay nothing for the only attempt they care about.
   */
  const correct = await json(
    await post('/auth/forgot/verify', { email: user.email, answer: user.answer }),
  )
  assert.equal(correct.status, 429, 'the lock did not hold against a correct answer')
  assert.equal(correct.body.token, undefined)

  // Being refused leaves the row alone, so retrying does not push the moment it
  // expires out in front of the caller.
  const held = await accountAllowance(user.email)
  assert.equal(held.count, locked.count)
  assert.equal(Number(held.locked_until), Number(locked.locked_until))
})

test('answering correctly does not hand the allowance back', async () => {
  const user = await makeUser({ answer: 'Blue Sky' })

  for (let i = 0; i < 3; i++) {
    await post('/auth/forgot/verify', { email: user.email, answer: 'wrong' })
  }
  assert.equal((await accountAllowance(user.email)).count, 3)

  const ok = await json(
    await post('/auth/forgot/verify', { email: user.email, answer: user.answer }),
  )
  assert.equal(ok.status, 200)

  const after = await accountAllowance(user.email)
  assert.ok(after, 'the successful answer cleared the counter')
  assert.equal(after.count, 3, 'a success refilled the allowance')

  // So the fourth wrong answer is the fourth, not the first of a new run.
  await post('/auth/forgot/verify', { email: user.email, answer: 'wrong' })
  assert.equal((await accountAllowance(user.email)).count, 4)
})

test('an address with no account is answered exactly like one that has', async () => {
  const known = await makeUser({ answer: 'Blue Sky', questionId: 'first-school' })
  const stranger = freshEmail()

  const real = await json(await post('/auth/forgot', { email: known.email }))
  const fake = await json(await post('/auth/forgot', { email: stranger }))

  assert.equal(fake.status, real.status)
  assert.deepEqual(Object.keys(fake.body), Object.keys(real.body))
  assert.deepEqual(Object.keys(fake.body.question).sort(), Object.keys(real.body.question).sort())
  assert.ok(fake.body.question.label.length > 0)

  const { body } = await json(await call('/auth/security-questions'))
  const ids = body.questions.map((q) => q.id)
  assert.ok(ids.includes(fake.body.question.id), 'the invented question is not a real one')
  assert.equal(real.body.question.id, 'first-school')

  // And it does not change its mind. A question that differed between two
  // probes of the same address would give the game away as plainly as a 404.
  const twice = await json(await post('/auth/forgot', { email: stranger }))
  assert.equal(twice.body.question.id, fake.body.question.id)
  assert.equal(twice.body.question.label, fake.body.question.label)
})

test('completing a reset destroys every session', async () => {
  const user = await makeUser({ answer: 'Blue Sky' })
  const cookies = []
  for (let i = 0; i < 3; i++) cookies.push(`${COOKIE_NAME}=${await createSession(user.id)}`)

  const before = await all('SELECT id FROM sessions WHERE user_id = $1', user.id)
  assert.equal(before.length, 3)

  const alive = await call('/auth/me', { headers: { Cookie: cookies[0] } })
  assert.equal(alive.status, 200)

  const { body } = await json(
    await post('/auth/forgot/verify', { email: user.email, answer: user.answer }),
  )
  const done = await json(await post('/auth/reset', { token: body.token, password: 'brand-new-password' }))
  assert.equal(done.status, 200)

  assert.equal((await all('SELECT id FROM sessions WHERE user_id = $1', user.id)).length, 0)
  for (const cookie of cookies) {
    assert.equal((await call('/auth/me', { headers: { Cookie: cookie } })).status, 401)
  }
})

test('a reset token works exactly once', async () => {
  const user = await makeUser({ answer: 'Blue Sky' })

  const { body } = await json(
    await post('/auth/forgot/verify', { email: user.email, answer: user.answer }),
  )
  const token = body.token

  const first = await json(await post('/auth/reset', { token, password: 'password-number-one' }))
  assert.equal(first.status, 200)

  const second = await json(await post('/auth/reset', { token, password: 'password-number-two' }))
  assert.equal(second.status, 400, 'the token was redeemed twice')
  assert.equal(second.body.field, 'token')

  // The second attempt did not take effect, which is the thing "single use"
  // is protecting: whoever redeemed it first owns the password.
  assert.equal((await json(await post('/auth/login', { email: user.email, password: 'password-number-one' }))).status, 200)
  assert.equal((await json(await post('/auth/login', { email: user.email, password: 'password-number-two' }))).status, 401)
})

test('changing the password re-sets the question and signs every other session out', async () => {
  const email = freshEmail()

  const created = await json(
    await post('/auth/signup', {
      displayName: 'Recovery Tester',
      email,
      password: 'the-first-password',
      acceptedTerms: true,
      securityQuestionId: 'first-pet',
      securityAnswer: 'Blue Sky',
    }),
  )
  assert.equal(created.status, 201)
  users.push(created.body.user.id)
  const id = created.body.user.id

  const elsewhere = `${COOKIE_NAME}=${await createSession(id)}`
  const mine = `${COOKIE_NAME}=${await createSession(id)}`

  const wrongCurrent = await json(
    await post(
      '/auth/password',
      {
        currentPassword: 'not-the-password',
        password: 'the-second-password',
        securityQuestionId: 'first-club',
        securityAnswer: 'Red Sky',
      },
      { Cookie: mine },
    ),
  )
  assert.equal(wrongCurrent.status, 400)
  assert.equal(wrongCurrent.body.field, 'currentPassword')
  assert.equal(
    (await all('SELECT id FROM sessions WHERE user_id = $1', id)).length,
    3,
    'a refused change signed people out anyway',
  )

  const res = await post(
    '/auth/password',
    {
      currentPassword: 'the-first-password',
      password: 'the-second-password',
      securityQuestionId: 'first-club',
      securityAnswer: ' Red  Sky ',
    },
    { Cookie: mine },
  )
  assert.equal(res.status, 200)

  // Every session gone, and one new one for the browser that did it.
  assert.equal((await all('SELECT id FROM sessions WHERE user_id = $1', id)).length, 1)
  assert.equal((await call('/auth/me', { headers: { Cookie: elsewhere } })).status, 401)
  assert.equal((await call('/auth/me', { headers: { Cookie: mine } })).status, 401)

  const replacement = sessionCookie(res)
  assert.ok(replacement, 'no replacement session came back')
  assert.equal((await call('/auth/me', { headers: { Cookie: replacement } })).status, 200)

  // The new question is what recovery now asks, and the new answer is what it
  // now takes, normalised the same way it was on the way in.
  const asked = await json(await post('/auth/forgot', { email }))
  assert.equal(asked.body.question.id, 'first-club')

  const stale = await json(await post('/auth/forgot/verify', { email, answer: 'blue sky' }))
  assert.equal(stale.status, 400, 'the old answer still works')

  const fresh = await json(await post('/auth/forgot/verify', { email, answer: 'RED SKY' }))
  assert.equal(fresh.status, 200)
})

test('changing a password needs a session', async () => {
  const { status } = await json(
    await post('/auth/password', {
      currentPassword: 'whatever',
      password: 'a-long-enough-password',
      securityQuestionId: 'first-pet',
      securityAnswer: 'Blue Sky',
    }),
  )
  assert.equal(status, 401)
})
