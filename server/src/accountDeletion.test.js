import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, all, get, closePool } from './db.js'
import { createSession, hashPassword, COOKIE_NAME } from './auth.js'
import { hashAnswer } from './securityQuestions.js'
import { codeForStep, stepAt } from './totp.js'
import { testBoard } from './testBoard.js'

/**
 * Deleting an account is the most destructive thing a session can ask for, so
 * it asks for what its neighbours ask for.
 *
 * `DELETE /api/auth/me` used to check one thing: that a session existed. It then
 * destroyed the account and, by cascade, every board saved under it, with no
 * backup to restore from. Beside it sat `POST /api/auth/password` and
 * `POST /api/auth/sessions`, which both go through `assertCurrentPassword` on an
 * argument written out at length in `handoff.md`: a session left open on a shared
 * machine must not be enough, or the control is a gift to the person it exists to
 * protect against. Deletion is strictly worse than either of those and was the
 * one door standing open.
 *
 * **And with two-step sign-in on, the password is no longer the whole story.**
 * The factor exists so that knowing the password is not enough to reach the
 * account. Leaving deletion behind the password alone would mean a stolen session
 * plus a known password destroys everything without the attacker ever meeting the
 * second factor, which is the same argument that put the factor in front of the
 * security-question reset rather than behind it.
 *
 * **A guest is deliberately let through on the session alone**, and that is not
 * an oversight repeated from somewhere else. A guest row has no password to
 * confirm, `verifyPassword` answers false for its null salt by design, so
 * demanding one would make deletion structurally impossible for that account.
 * `PrivacyPolicy.tsx` tells everybody they may withdraw consent by deleting their
 * account, with no exception for guests, and the session really is the only
 * credential such an account has: whoever holds it already has everything the
 * account can reach, so this is not an escalation.
 */

const PORT = 8819
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/**
 * Its own bucket, above .200 where `rateLimit.test.js` writes.
 *
 * `assertCurrentPassword` charges `confirm:${userId}`, which is keyed on the
 * account and so cannot collide with a neighbour. The address is here for the
 * factor allowance, which has a per-IP half.
 */
const SUITE_IP = '203.0.113.221'

let child
const users = []

function startInstance() {
  child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${PORT}`,
      // Without this `req.ip` is the socket address and the header below is
      // ignored, so this suite would silently share the loopback bucket.
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    if (!text.includes('ENCRYPTION_KEY')) process.stderr.write(`[${PORT}] ${text}`)
  })
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

const call = (path, cookie, init = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      'X-Forwarded-For': SUITE_IP,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const read = async (res) => {
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null }
}

/** `DELETE` with a body, which is what this endpoint now takes. */
const remove = (cookie, body) =>
  call('/auth/me', cookie, { method: 'DELETE', body: JSON.stringify(body ?? {}) })

/**
 * A real account, inserted directly rather than through `/signup`, so a suite
 * that is not about signing up does not spend that allowance.
 */
async function makeUser({ password = 'a-real-password-1' } = {}) {
  const id = randomUUID()
  const email = `${id}@test.invalid`
  const [secret, digest] = await Promise.all([hashPassword(password), hashAnswer('Blue Sky')])
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        display_name, security_question_id, security_answer_hash,
                        security_answer_salt)
     VALUES ($1, $2, $3, $4, $5, $5, 'Tester', 'first-pet', $6, $7)`,
    id,
    email,
    secret.hash,
    secret.salt,
    new Date().toISOString(),
    digest.hash,
    digest.salt,
  )
  users.push(id)
  return { id, email, password, cookie: `${COOKIE_NAME}=${await createSession(id)}` }
}

/** A guest exactly as `admitAsGuest` writes one: no address, no password. */
async function makeGuest() {
  const id = randomUUID()
  await run(
    `INSERT INTO users (id, accepted_terms_at, created_at, is_guest, display_name)
     VALUES ($1, $2, $2, true, 'Anonymous Quokka')`,
    id,
    new Date().toISOString(),
  )
  users.push(id)
  return { id, cookie: `${COOKIE_NAME}=${await createSession(id)}` }
}

const codeAt = (secret, offset = 0) => codeForStep(secret, stepAt() + offset)

/**
 * Turn the factor on through the endpoints that turn it on.
 *
 * Not by writing `totp_secret` here, which would need `initEncryption()` in the
 * test process and would encode this file's guess about how enrollment stores a
 * secret. Going through the API means the factor these tests meet is the one the
 * product actually creates.
 */
async function enableFactor(person) {
  const begun = await read(
    await call('/auth/2fa/enroll', person.cookie, {
      method: 'POST',
      body: JSON.stringify({ currentPassword: person.password }),
    }),
  )
  assert.equal(begun.status, 200, begun.text)
  const done = await read(
    await call('/auth/2fa/confirm', person.cookie, {
      method: 'POST',
      body: JSON.stringify({ code: codeAt(begun.body.secret) }),
    }),
  )
  assert.equal(done.status, 200, done.text)
  return begun.body.secret
}

const stillExists = async (id) =>
  Boolean(await get('SELECT id FROM users WHERE id = $1', id))

before(async () => {
  await migrate()
  startInstance()
  await waitForHealth()
})

after(async () => {
  child?.kill()
  for (const id of users) {
    await run('DELETE FROM session_revocations WHERE user_id = $1', id)
    await run('DELETE FROM boards WHERE user_id = $1', id)
    await run('DELETE FROM users WHERE id = $1', id)
    await run('DELETE FROM login_attempts WHERE key = $1', `confirm:${id}`)
    await run('DELETE FROM login_attempts WHERE key = $1', `factor:${id}`)
  }
  await run('DELETE FROM login_attempts WHERE key = $1', `factor-ip:${SUITE_IP}`)
  await closePool()
})

test('deleting without a current password is refused, and the account survives', async () => {
  const person = await makeUser()

  const answered = await read(await remove(person.cookie, {}))

  assert.equal(answered.status, 400, answered.text)
  assert.equal(answered.body.field, 'currentPassword')
  assert.ok(await stillExists(person.id), 'the account was destroyed without a password')
  // The session it asked from is untouched too, or a refusal would still have
  // cost the caller their sign-in.
  assert.equal((await read(await call('/auth/me', person.cookie))).status, 200)
})

test('a wrong password is refused and destroys nothing', async () => {
  const person = await makeUser()
  const board = await read(
    await call('/boards', person.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Kept', data: testBoard() }),
    }),
  )
  assert.equal(board.status, 201, board.text)

  const answered = await read(await remove(person.cookie, { currentPassword: 'not-it' }))

  assert.equal(answered.status, 400, answered.text)
  assert.ok(await stillExists(person.id))
  assert.equal(
    (await all('SELECT id FROM boards WHERE user_id = $1', person.id)).length,
    1,
    'a board went with a refused deletion',
  )
})

test('the right password deletes the account and its boards', async () => {
  const person = await makeUser()
  const board = await read(
    await call('/boards', person.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Going', data: testBoard() }),
    }),
  )
  assert.equal(board.status, 201, board.text)

  const answered = await remove(person.cookie, { currentPassword: person.password })

  assert.equal(answered.status, 204)
  assert.equal(await stillExists(person.id), false, 'the account survived its own deletion')
  assert.equal((await all('SELECT id FROM boards WHERE user_id = $1', person.id)).length, 0)
  assert.equal(
    (await all('SELECT id FROM sessions WHERE user_id = $1', person.id)).length,
    0,
    'a session outlived the account it belonged to',
  )
})

test('with a factor on, the password alone does not delete the account', async () => {
  const person = await makeUser()
  await enableFactor(person)

  const answered = await read(await remove(person.cookie, { currentPassword: person.password }))

  /**
   * The point of the whole feature, applied to the one irreversible action.
   *
   * If the password alone were enough here, somebody holding a stolen session
   * and the password would destroy the account and every board in it without
   * ever meeting the second factor, which is exactly what the factor exists to
   * make impossible.
   */
  assert.equal(answered.status, 400, answered.text)
  assert.equal(answered.body.field, 'code')
  assert.ok(await stillExists(person.id), 'the factor was not asked for')
})

test('with a factor on, the password and a code together delete it', async () => {
  const person = await makeUser()
  const secret = await enableFactor(person)

  /**
   * The *next* step's code, not this one's, and that is the replay defence
   * rather than a quirk of the test.
   *
   * `confirmEnrollment` banks the step it was confirmed with in
   * `totp_last_step`, precisely so the code somebody just typed to switch the
   * factor on cannot be turned around and spent again while it is still live.
   * Enrollment happened milliseconds ago here, so the current step is exactly
   * the spent one. A real person deleting an account reads a fresh code off
   * their phone; this is the same thing with the waiting removed.
   */
  const answered = await remove(person.cookie, {
    currentPassword: person.password,
    code: codeAt(secret, 1),
  })

  assert.equal(answered.status, 204)
  assert.equal(await stillExists(person.id), false)
})

test('a guest deletes their own account on the session alone', async () => {
  const guest = await makeGuest()

  /**
   * There is no password on that row to confirm, so demanding one would make
   * this impossible rather than merely harder, and the privacy policy promises
   * deletion to everybody without excepting guests. Whoever holds this session
   * already has everything the account can reach, so nothing is escalated.
   */
  const answered = await remove(guest.cookie, {})

  assert.equal(answered.status, 204)
  assert.equal(await stillExists(guest.id), false, 'a guest cannot delete their own account')
})
