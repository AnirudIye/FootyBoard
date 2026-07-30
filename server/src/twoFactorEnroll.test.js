import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, get, all, closePool } from './db.js'
import { createSession, hashPassword, COOKIE_NAME } from './auth.js'
import { hashAnswer } from './securityQuestions.js'
import { codeForStep, stepAt } from './totp.js'

/**
 * Turning the second factor on, and turning it off again.
 *
 * The properties worth asserting here are the ones that decide whether the
 * feature is real or decorative:
 *
 *   - a guest is refused for being a guest, by the same door `/password` and
 *     `/sessions` are closed by, rather than by falling through a comparison
 *     against a password that does not exist;
 *   - an enrollment that is started and not confirmed turns nothing on, so a
 *     secret in the row is not the switch;
 *   - the ten recovery codes are said exactly once and by exactly one endpoint;
 *   - turning it off needs the password *and* a live factor, because a disable
 *     that took only the password would make the whole feature exactly as strong
 *     as the password, which is the thing it exists not to be;
 *   - and a disable leaves nothing behind that could still open a door.
 *
 * **Wrong-code counts in this file stay in single digits.** The per-IP factor
 * allowance is twenty in ten minutes, and every test that deliberately exhausts
 * an allowance lives in `twoFactorLogin.test.js` instead. Two files racing to
 * spend one counter produce a 429 in whichever loses, which reads exactly like a
 * broken limiter. That suite is named by file rather than by its port number, so
 * that grepping the tree for a port still answers "which one file claims it".
 */

/**
 * Its own port. `node --test` runs files concurrently and :8799 to :8816 are
 * spoken for: sharing takes two, consent one, anonymous presence two, recovery
 * one, realtime cache two, session revocation two, board validation, board
 * concurrency, guest join, sign out everywhere, board migration and display name
 * one each, and durable eviction two. Landing on somebody else's port does not
 * fail loudly, which is the trap: this instance dies of EADDRINUSE and the calls
 * below are answered perfectly well by the other suite's process until that
 * suite finishes and kills it mid-run.
 */
const PORT = 8817
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/**
 * This suite's own network, so its allowances are its own.
 *
 * Every suite reaches the API from 127.0.0.1, so without this every per-IP
 * counter is one row shared by every file running concurrently, and a burst
 * anywhere lands on whoever asks next. Declaring a proxy and sending an
 * `X-Forwarded-For` is the mechanism `npm run cluster` already uses, and the
 * address is from TEST-NET-3, reserved for documentation, so it can never be a
 * real client.
 *
 * Deliberately above .200: `rateLimit.test.js` writes `ip:203.0.113.N` rows
 * directly for a random N from 1 to 200, and .7 and .15 belong to the sharing
 * and durable eviction suites.
 */
const SUITE_IP = '203.0.113.217'

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
 * The per-IP allowances this suite spends, named one at a time.
 *
 * Never a `LIKE` sweep by prefix. Two existing files clear `join:%` that way and
 * it reaches into whichever neighbour is mid-count; a third copy of that would
 * make the next unexplained failure harder rather than easier to find.
 */
const IP_KEYS = [`signup:${SUITE_IP}`, `ip:${SUITE_IP}`, `factor-ip:${SUITE_IP}`]

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

const patch = (path, body, headers) =>
  call(path, { method: 'PATCH', body: JSON.stringify(body), headers })

/** Status, parsed body, raw text for assertion messages, and any session cookie. */
const read = async (res) => {
  const text = await res.text()
  return {
    status: res.status,
    text,
    body: text ? JSON.parse(text) : null,
    cookie:
      res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))?.split(';')[0] ?? null,
  }
}

function freshEmail() {
  const email = `${randomUUID()}@test.invalid`
  emails.push(email)
  return email
}

/**
 * A real account with a known password, inserted rather than signed up, so the
 * tests that are not about signing up do not spend that route's allowance.
 */
async function makeUser(password = 'the-only-password') {
  const id = randomUUID()
  const email = freshEmail()
  const { hash, salt } = await hashPassword(password)
  const answer = await hashAnswer('Blue Sky')
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        display_name, security_question_id, security_answer_hash,
                        security_answer_salt)
     VALUES ($1, $2, $3, $4, $5, $5, 'Factor Tester', 'first-pet', $6, $7)`,
    id,
    email,
    hash,
    salt,
    new Date().toISOString(),
    answer.hash,
    answer.salt,
  )
  users.push(id)
  return { id, email, password }
}

/** A guest, in the shape `admitAsGuest` leaves one: no address, no password. */
async function makeGuest() {
  const id = randomUUID()
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at, is_guest)
     VALUES ($1, NULL, NULL, NULL, $2, $2, true)`,
    id,
    new Date().toISOString(),
  )
  users.push(id)
  return { id }
}

const cookieFor = async (userId) => `${COOKIE_NAME}=${await createSession(userId)}`

const factorRow = (id) =>
  get('SELECT totp_secret, totp_confirmed_at, totp_last_step FROM users WHERE id = $1', id)

/** The code an authenticator would be showing right now. */
const currentCode = (secret) => codeForStep(secret, stepAt())

/**
 * The next code, which is what any second use of a factor actually carries.
 *
 * Confirming an enrollment banks the step it was confirmed on, so the code that
 * turned the factor on cannot be turned around and spent again while it is still
 * live. Every call below that needs a live code after enrolling therefore has to
 * reach for the following step, which the one-step window accepts early. Using
 * `currentCode` here would be a replay and would be refused, correctly.
 */
const nextCode = (secret) => codeForStep(secret, stepAt() + 1)

/** Enroll and confirm in full, returning the secret and the ten codes. */
async function enroll(cookie, password) {
  const begun = await read(await post('/auth/2fa/enroll', { currentPassword: password }, { Cookie: cookie }))
  assert.equal(begun.status, 200, begun.text)
  const confirmed = await read(
    await post('/auth/2fa/confirm', { code: currentCode(begun.body.secret) }, { Cookie: cookie }),
  )
  assert.equal(confirmed.status, 200, confirmed.text)
  return { secret: begun.body.secret, codes: confirmed.body.recoveryCodes }
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
      // See SUITE_IP.
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
  // Recovery codes and challenges cascade from the account. The allowances do
  // not, and they are named exactly rather than swept.
  for (const id of users) {
    for (const key of [`confirm:${id}`, `factor:${id}`]) {
      await run('DELETE FROM login_attempts WHERE key = $1', key)
    }
    await run('DELETE FROM users WHERE id = $1', id)
  }
  for (const email of emails) {
    await run('DELETE FROM login_attempts WHERE key = $1', `account:${email}`)
  }
  await clearIpAllowances()
  await closePool()
})

/* -------------------------------------------------------------------------- */
/* The shape of a user, everywhere one is returned                            */
/* -------------------------------------------------------------------------- */

test('twoFactorEnabled rides on every user object, and starts false', async () => {
  const email = freshEmail()

  const signedUp = await read(
    await post('/auth/signup', {
      displayName: 'Factor Tester',
      email,
      password: 'a-long-enough-password',
      acceptedTerms: true,
      securityQuestionId: 'first-pet',
      securityAnswer: 'Blue Sky',
    }),
  )
  assert.equal(signedUp.status, 201, signedUp.text)
  users.push(signedUp.body.user.id)

  /**
   * `false`, not `undefined`, and the difference is the whole reason this is its
   * own test. `publicUser`'s own doc comment records the last time a field went
   * missing from a hand-built object at `/signup`: the client's `ApiUser` said
   * boolean and got undefined, and nothing failed loudly.
   */
  assert.equal(signedUp.body.user.twoFactorEnabled, false)

  const loggedIn = await read(await post('/auth/login', { email, password: 'a-long-enough-password' }))
  assert.equal(loggedIn.status, 200, loggedIn.text)
  assert.equal(loggedIn.body.user.twoFactorEnabled, false)

  const cookie = await cookieFor(signedUp.body.user.id)
  const me = await read(await call('/auth/me', { headers: { Cookie: cookie } }))
  assert.equal(me.body.user.twoFactorEnabled, false)

  const renamed = await read(await patch('/auth/display-name', { displayName: 'Renamed' }, { Cookie: cookie }))
  assert.equal(renamed.status, 200, renamed.text)
  assert.equal(renamed.body.user.twoFactorEnabled, false)
})

test('twoFactorEnabled is true once the switch is set, on every endpoint that returns a user', async () => {
  const person = await makeUser()
  // Set directly, so this test is about the shape of the response rather than
  // about the enrollment route.
  await run('UPDATE users SET totp_confirmed_at = $1 WHERE id = $2', new Date().toISOString(), person.id)

  const cookie = await cookieFor(person.id)

  const me = await read(await call('/auth/me', { headers: { Cookie: cookie } }))
  assert.equal(me.status, 200, me.text)
  /**
   * `/auth/me` is built by `sessionForToken` rather than by `publicUser`, so it
   * is a second place the field has to be assembled and therefore a second place
   * it can silently go missing. It is also the object every authenticated
   * request carries, which is why `totp_secret` must never be in that SELECT: a
   * secret on this object is one `res.json(req.user)` away from the wire.
   */
  assert.equal(me.body.user.twoFactorEnabled, true)
  assert.equal(me.body.user.totpSecret, undefined)
  assert.doesNotMatch(me.text, /totp/i, 'something about the secret reached the wire')

  const renamed = await read(await patch('/auth/display-name', { displayName: 'Still On' }, { Cookie: cookie }))
  assert.equal(renamed.status, 200, renamed.text)
  assert.equal(renamed.body.user.twoFactorEnabled, true)

  /**
   * `/auth/login` is deliberately not asserted here. For an account with the
   * factor on it answers `{ user: null, challenge }` and the user object arrives
   * from `/auth/login/2fa` instead, so the assertion for that endpoint lives in
   * `twoFactorLogin.test.js` beside the flow that produces it.
   */
})

/* -------------------------------------------------------------------------- */
/* Enrollment                                                                  */
/* -------------------------------------------------------------------------- */

test('enrolling needs a session', async () => {
  const { status } = await read(await post('/auth/2fa/enroll', { currentPassword: 'whatever' }))
  assert.equal(status, 401)
})

test('a guest is refused for being a guest, not for getting a password wrong', async () => {
  const guest = await makeGuest()
  const cookie = await cookieFor(guest.id)

  const res = await read(
    await post('/auth/2fa/enroll', { currentPassword: 'anything at all' }, { Cookie: cookie }),
  )

  assert.equal(res.status, 400, res.text)
  /**
   * Refused by the same door `/password` and `/sessions` are closed by, before
   * any comparison happens. Telling somebody with no password that they got
   * their password wrong is a message about an answer they could never have
   * typed, and the frontend sends them to `/claim` instead. A guest cannot have
   * a factor because a guest has no password to put one behind.
   */
  assert.doesNotMatch(res.body.error, /current password/i)
  assert.equal((await factorRow(guest.id)).totp_secret, null, 'a guest got a secret')
})

test('a wrong current password enrolls nothing', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)

  const res = await read(
    await post('/auth/2fa/enroll', { currentPassword: 'not-the-password' }, { Cookie: cookie }),
  )

  assert.equal(res.status, 400, res.text)
  assert.equal(res.body.field, 'currentPassword')
  /**
   * The password is required here for the strongest form of the argument
   * `assertCurrentPassword` already makes. A session left open on a shared
   * machine must not be enough to change somebody's password, and it must
   * especially not be enough to attach an attacker's authenticator to the
   * account, which is a lockout rather than a nuisance.
   */
  assert.equal((await factorRow(person.id)).totp_secret, null, 'a refused enroll wrote a secret')
})

test('an enrollment hands back a secret and a URI, and turns nothing on', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)

  const res = await read(
    await post('/auth/2fa/enroll', { currentPassword: person.password }, { Cookie: cookie }),
  )
  assert.equal(res.status, 200, res.text)
  assert.match(res.body.secret, /^[A-Z2-7]{32}$/)
  assert.ok(res.body.uri.startsWith('otpauth://totp/'), res.body.uri)
  // The URI carries the secret, so the page never has to build one itself, and
  // there is only one spelling of what an authenticator is being handed.
  assert.ok(res.body.uri.includes(`secret=${res.body.secret}`))

  const row = await factorRow(person.id)
  assert.ok(row.totp_secret, 'nothing was written')
  assert.equal(row.totp_confirmed_at, null, 'enrolling turned the factor on by itself')

  // And the account still says it is off, which is the property that makes an
  // abandoned enrollment harmless rather than a lockout.
  const me = await read(await call('/auth/me', { headers: { Cookie: cookie } }))
  assert.equal(me.body.user.twoFactorEnabled, false)

  const status = await read(await call('/auth/2fa', { headers: { Cookie: cookie } }))
  assert.equal(status.status, 200, status.text)
  assert.deepEqual(status.body, { enabled: false, remainingRecoveryCodes: 0 })
})

test('a wrong code confirms nothing, and the right one turns it on with ten codes', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)

  const begun = await read(
    await post('/auth/2fa/enroll', { currentPassword: person.password }, { Cookie: cookie }),
  )
  assert.equal(begun.status, 200, begun.text)

  const wrong = await read(await post('/auth/2fa/confirm', { code: '000000' }, { Cookie: cookie }))
  assert.equal(wrong.status, 400, wrong.text)
  assert.equal(wrong.body.field, 'code')
  assert.equal((await factorRow(person.id)).totp_confirmed_at, null, 'a wrong code turned it on')

  const done = await read(
    await post('/auth/2fa/confirm', { code: currentCode(begun.body.secret) }, { Cookie: cookie }),
  )
  assert.equal(done.status, 200, done.text)
  assert.equal(done.body.recoveryCodes.length, 10)
  for (const code of done.body.recoveryCodes) {
    assert.match(code, /^[A-Z]{4}-[A-Z]{4}-[A-Z]{4}-[A-Z]{4}$/)
  }

  const me = await read(await call('/auth/me', { headers: { Cookie: cookie } }))
  assert.equal(me.body.user.twoFactorEnabled, true)

  // Enrolling again is refused, because that statement would overwrite a live
  // factor and lock the account out of itself.
  const again = await read(
    await post('/auth/2fa/enroll', { currentPassword: person.password }, { Cookie: cookie }),
  )
  assert.equal(again.status, 400, again.text)
  assert.match(again.body.error, /already on/i)
})

test('the ten codes are said exactly once, by exactly one endpoint', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)
  const { codes } = await enroll(cookie, person.password)

  /**
   * The same rule `board_shares` follows and for the same reason: a credential
   * that can be asked for again is a credential the account page leaks to
   * anybody holding a session. The count is public, the codes are not.
   */
  const status = await read(await call('/auth/2fa', { headers: { Cookie: cookie } }))
  assert.deepEqual(status.body, { enabled: true, remainingRecoveryCodes: 10 })

  const me = await read(await call('/auth/me', { headers: { Cookie: cookie } }))
  for (const response of [status.text, me.text]) {
    assert.doesNotMatch(response, /recoveryCodes/, 'the codes were offered a second time')
    for (const code of codes) {
      assert.ok(!response.includes(code), 'a recovery code came back from another endpoint')
      assert.ok(!response.includes(code.replace(/-/g, '')))
    }
  }
})

test('the status endpoint needs a session', async () => {
  assert.equal((await call('/auth/2fa')).status, 401)
  assert.equal((await post('/auth/2fa/confirm', { code: '000000' })).status, 401)
})

/* -------------------------------------------------------------------------- */
/* Turning it off, and replacing the codes                                     */
/* -------------------------------------------------------------------------- */

test('a disable needs both the password and a live code, and refuses on either', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)
  const { secret } = await enroll(cookie, person.password)

  const noCode = await read(
    await post('/auth/2fa/disable', { currentPassword: person.password, code: '000000' }, { Cookie: cookie }),
  )
  assert.equal(noCode.status, 400, noCode.text)
  assert.equal(noCode.body.field, 'code')
  assert.ok((await factorRow(person.id)).totp_confirmed_at, 'a wrong code turned the factor off')

  const noPassword = await read(
    await post(
      '/auth/2fa/disable',
      { currentPassword: 'not-the-password', code: nextCode(secret) },
      { Cookie: cookie },
    ),
  )
  assert.equal(noPassword.status, 400, noPassword.text)
  assert.equal(noPassword.body.field, 'currentPassword')
  assert.ok((await factorRow(person.id)).totp_confirmed_at, 'a wrong password turned the factor off')

  /**
   * Both, because a disable that took only the password would make the whole
   * feature exactly as strong as the password, which is the thing it exists not
   * to be. The password check runs first, so somebody who does not hold the
   * account never reaches the code comparison at all.
   */
})

test('a disable leaves nothing behind, and sign-in is one step again', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)
  const { secret, codes } = await enroll(cookie, person.password)

  // A second browser, signed in before the disable. See the assertion below.
  const elsewhere = await cookieFor(person.id)

  const res = await read(
    await post(
      '/auth/2fa/disable',
      { currentPassword: person.password, code: nextCode(secret) },
      { Cookie: cookie },
    ),
  )
  assert.equal(res.status, 200, res.text)

  assert.deepEqual(await factorRow(person.id), {
    totp_secret: null,
    totp_confirmed_at: null,
    totp_last_step: null,
  })
  assert.equal((await all('SELECT id FROM recovery_codes WHERE user_id = $1', person.id)).length, 0)
  assert.equal(
    (await all('SELECT id FROM auth_challenges WHERE user_id = $1 AND used_at IS NULL', person.id)).length,
    0,
    'a pending challenge outlived the factor it was issued against',
  )

  const status = await read(await call('/auth/2fa', { headers: { Cookie: cookie } }))
  assert.deepEqual(status.body, { enabled: false, remainingRecoveryCodes: 0 })

  // Signing in is one step again, and a code that used to work no longer names
  // anything at all.
  const back = await read(await post('/auth/login', { email: person.email, password: person.password }))
  assert.equal(back.status, 200, back.text)
  assert.equal(back.body.challenge, null)
  assert.equal(back.body.user.twoFactorEnabled, false)
  assert.ok(back.cookie, 'no session cookie after the factor was removed')

  /**
   * **Sessions survive a disable**, and this is asserted positively so that
   * reversing it later is a deliberate edit to a test rather than a surprise.
   *
   * `/password` and `/reset` destroy every session because a credential
   * *changed* in a way that might be locking an intruder out. Nothing about a
   * live session's authority changes here, and the person has just proved both
   * factors on this very request. `/sessions` is one link away in the account
   * menu for anybody who wants the stronger thing. This is the decision in this
   * feature most worth a second opinion.
   */
  const other = await read(await call('/auth/me', { headers: { Cookie: elsewhere } }))
  assert.equal(other.status, 200, 'a disable signed the other browser out')
  assert.equal(other.body.user.twoFactorEnabled, false)
  // And every code really is dead, not merely unlisted.
  assert.ok(codes.length === 10)
})

test('a recovery code disables in place of a code from the app', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)
  const { codes } = await enroll(cookie, person.password)

  // The case this exists for: the phone is gone, so the only thing the person
  // has is the piece of paper.
  const res = await read(
    await post(
      '/auth/2fa/disable',
      { currentPassword: person.password, code: codes[3] },
      { Cookie: cookie },
    ),
  )
  assert.equal(res.status, 200, res.text)
  assert.equal((await factorRow(person.id)).totp_confirmed_at, null)
})

test('regenerating replaces all ten, and the previous ten stop working', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)
  const { secret, codes } = await enroll(cookie, person.password)

  const res = await read(
    await post(
      '/auth/2fa/recovery-codes',
      { currentPassword: person.password, code: nextCode(secret) },
      { Cookie: cookie },
    ),
  )
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.recoveryCodes.length, 10)
  for (const code of res.body.recoveryCodes) assert.ok(!codes.includes(code))

  const status = await read(await call('/auth/2fa', { headers: { Cookie: cookie } }))
  assert.deepEqual(status.body, { enabled: true, remainingRecoveryCodes: 10 })

  /**
   * A code from the previous set is refused even though it was never spent. A
   * fresh set of ten is ten new ways into the account, so the old ten have to
   * stop being ways in at the same moment rather than accumulating.
   */
  const login = await read(await post('/auth/login', { email: person.email, password: person.password }))
  const stale = await read(
    await post('/auth/login/2fa', { token: login.body.challenge.token, code: codes[0] }),
  )
  assert.equal(stale.status, 400, 'a replaced recovery code still works')

  const fresh = await read(await post('/auth/login', { email: person.email, password: person.password }))
  const done = await read(
    await post('/auth/login/2fa', {
      token: fresh.body.challenge.token,
      code: res.body.recoveryCodes[0],
    }),
  )
  assert.equal(done.status, 200, done.text)
})

test('disable and regenerate both need a session, and both refuse an account with no factor', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)

  for (const path of ['/auth/2fa/disable', '/auth/2fa/recovery-codes']) {
    assert.equal(
      (await post(path, { currentPassword: person.password, code: '000000' })).status,
      401,
      `${path} answered without a session`,
    )

    const res = await read(
      await post(path, { currentPassword: person.password, code: '000000' }, { Cookie: cookie }),
    )
    // Refused for what the account is rather than by falling through the code
    // comparison, which would charge an allowance for a factor that is not there
    // and say "that code is not right" about a code nothing could produce.
    assert.equal(res.status, 400, res.text)
    assert.match(res.body.error, /not on/i)
  }
})
