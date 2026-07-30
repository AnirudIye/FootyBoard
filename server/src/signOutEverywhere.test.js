import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, all, run, closePool } from './db.js'
import { createSession, hashPassword, COOKIE_NAME } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * Ending every session for an account without changing the password.
 *
 * `POST /api/auth/password` already destroyed every session, and for a long time
 * it was the only control that did, so somebody who suspected a session had been
 * taken had to invent a new password in order to throw it out. This is that
 * control with the password change taken out, and the four things worth asserting
 * are the four ways it could be got wrong.
 *
 * **The other sessions really stop working.** Both halves: the row is gone, so
 * REST refuses them, and the socket that row let in is closed, so the room stops
 * relaying edits in either direction. A `DELETE FROM sessions` written in the
 * route instead of going through `sessions.js` passes the first half and fails
 * the second, which is exactly the defect this repo already had once.
 *
 * **The caller is not locked out, and is not spared either.** The session this
 * request arrives on is destroyed with all the others, including its rooms, and
 * the response hands the browser a new one. Sparing the caller's sockets would be
 * the same hole reached from the friendlier direction, so the assertion is that
 * the old socket closes *and* the new cookie works.
 *
 * **A wrong password destroys nothing.** The whole value of the endpoint to
 * somebody being impersonated is that it is worth nothing to the impersonator, so
 * a refusal has to happen before anything is deleted rather than after.
 *
 * **A guest is refused for being a guest.** There is no password on that row to
 * verify and exactly one session to revoke, and "that is not your current
 * password" is not a true thing to say to an account that has none.
 *
 * One instance on :8812, which no other suite claims. That is enough to hold the
 * eviction happening at all, and deliberately not enough to hold it *travelling*:
 * in one process the session destruction and the socket share memory. The
 * cross-instance half is `sessionRevocation.test.js`, which makes every eviction
 * on the instance that is not holding the socket it has to close.
 *
 * Nothing here spends a rate-limit allowance, so nothing here cleans one up.
 * `/auth/sessions`, `/auth/me`, `POST /boards` and the socket all count against
 * nothing, and the per-IP keys are shared with every other suite in this
 * database: sweeping them would be this file reaching into a run it knows nothing
 * about. Users are inserted directly and sessions minted with `createSession` for
 * the same reason, rather than driving `/signup` and `/login`.
 */

const PORT = 8812
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

const users = []
let child

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
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const post = (path, body, cookie) =>
  call(path, cookie, { method: 'POST', body: JSON.stringify(body) })

/** Status, parsed body, raw text for assertion messages, and any session cookie. */
const read = async (res) => {
  const text = await res.text()
  return {
    status: res.status,
    text,
    body: text ? JSON.parse(text) : null,
    cookie: res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))?.split(';')[0] ?? null,
  }
}

/**
 * A real account with a real password, inserted rather than signed up.
 *
 * Signing up would spend this network's signup allowance, which is a row shared
 * with every other suite, and the digest is stored exactly the way `/signup`
 * stores it so the endpoint's password check is driven for real.
 */
async function makeUser(password = 'the-only-password') {
  const id = randomUUID()
  const { hash, salt } = await hashPassword(password)
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        security_question_id, security_answer_hash, security_answer_salt)
     VALUES ($1, $2, $3, $4, $5, $5, 'first-pet', $6, $7)`,
    id,
    `${id}@test.invalid`,
    hash,
    salt,
    new Date().toISOString(),
    hash,
    salt,
  )
  users.push(id)
  return { id, password }
}

/**
 * A guest account, in the shape `admitAsGuest` leaves one: no address, no
 * password hash, no salt, `is_guest` true. Created here rather than by redeeming
 * a code, because the join flow spends two per-IP allowances and this file is not
 * about how somebody got in.
 */
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

const liveSessions = async (userId) =>
  (await all('SELECT id FROM sessions WHERE user_id = $1', userId)).length

async function makeBoard(cookie) {
  const created = await read(await post('/boards', { name: 'Session board', data: testBoard() }, cookie))
  assert.equal(created.status, 201, created.text)
  return created.body.board.id
}

/** Resolves on `welcome`, since an open socket may still be a moment from being closed. */
async function openSocket(board, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?board=${board}`, {
    headers: { Cookie: cookie },
  })
  socket.closeInfo = null
  socket.on('close', (code) => {
    socket.closeInfo = { code }
  })

  await new Promise((resolve, reject) => {
    socket.on('message', function first(raw) {
      if (JSON.parse(raw).type !== 'welcome') return
      socket.off('message', first)
      resolve()
    })
    socket.once('close', (code) => reject(Object.assign(new Error(`closed ${code}`), { code })))
    socket.once('error', reject)
  })
  return socket
}

function waitForClose(socket, timeoutMs = 5000) {
  if (socket.closeInfo) return Promise.resolve(socket.closeInfo.code)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the socket was still open ${timeoutMs}ms later`)),
      timeoutMs,
    )
    socket.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

before(async () => {
  await migrate()
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

after(async () => {
  child?.kill()
  // Boards first, then the accounts: sessions and boards would cascade, but a
  // cascade is not what this file is testing and being explicit costs nothing.
  for (const id of users) {
    await run('DELETE FROM boards WHERE user_id = $1', id)
    await run('DELETE FROM users WHERE id = $1', id)
  }
  await closePool()
})

test('every other session is ended, rooms included, and the caller is handed a new one', async () => {
  const person = await makeUser()
  const mine = await cookieFor(person.id)
  const laptop = await cookieFor(person.id)
  const tablet = await cookieFor(person.id)
  const board = await makeBoard(mine)

  const mySocket = await openSocket(board, mine)
  const laptopSocket = await openSocket(board, laptop)

  const res = await read(await post('/auth/sessions', { currentPassword: person.password }, mine))
  assert.equal(res.status, 200, res.text)

  // Exactly one row survives, and it is the one this response is handing back.
  assert.equal(await liveSessions(person.id), 1)
  assert.equal((await call('/auth/me', laptop)).status, 401)
  assert.equal((await call('/auth/me', tablet)).status, 401)
  assert.equal((await call('/auth/me', mine)).status, 401, 'the session that asked was spared')

  /**
   * The socket half, which is the one that was missing from every revocation in
   * this codebase once. Deleting the row is a complete revocation for REST and
   * nothing at all to a connection that is already open, so a route that deleted
   * from `sessions` itself instead of going through `sessions.js` would pass
   * every assertion above and fail these two.
   *
   * The caller's own socket closing is not collateral damage, it is the rule:
   * that session really is gone, and sparing the sockets belonging to whoever
   * asked is the same hole reached from the friendlier direction.
   */
  assert.equal(await waitForClose(laptopSocket), 4401, 'another browser kept its room')
  assert.equal(await waitForClose(mySocket), 4401, 'the replaced session kept its room')

  const replacement = res.cookie
  assert.ok(replacement, 'no replacement session came back')
  assert.equal((await call('/auth/me', replacement)).status, 200)
  assert.equal((await call('/boards', replacement)).status, 200)

  // And it is a session in full, not merely one `/auth/me` accepts: it opens a
  // room, which is the thing the caller's old cookie can no longer do.
  const rejoined = await openSocket(board, replacement)
  rejoined.close()
})

test('a wrong password destroys nothing', async () => {
  const person = await makeUser()
  const mine = await cookieFor(person.id)
  const elsewhere = await cookieFor(person.id)

  const res = await read(await post('/auth/sessions', { currentPassword: 'not-the-password' }, mine))

  // 400 rather than "well, nothing happened": the refusal has to come before the
  // delete, or the endpoint signs an account out on behalf of a wrong guess.
  assert.equal(res.status, 400, res.text)
  assert.equal(res.body.field, 'currentPassword')
  assert.equal(await liveSessions(person.id), 2)
  assert.equal((await call('/auth/me', mine)).status, 200)
  assert.equal((await call('/auth/me', elsewhere)).status, 200)
})

test('a missing password is refused, not treated as an empty one', async () => {
  const person = await makeUser()
  const mine = await cookieFor(person.id)

  const res = await read(await post('/auth/sessions', {}, mine))

  assert.equal(res.status, 400, res.text)
  assert.equal(res.body.field, 'currentPassword')
  assert.equal(await liveSessions(person.id), 1)
})

test('a caller with no session of their own gets nowhere', async () => {
  const person = await makeUser()
  await cookieFor(person.id)

  const res = await read(await post('/auth/sessions', { currentPassword: person.password }, null))

  // The account is named by the cookie and never by the body, so there is no
  // shape of this request that ends somebody else's sessions.
  assert.equal(res.status, 401, res.text)
  assert.equal(await liveSessions(person.id), 1)
})

test('a guest is refused for being a guest, and keeps the one session they have', async () => {
  const guest = await makeGuest()
  const cookie = await cookieFor(guest.id)

  const res = await read(await post('/auth/sessions', { currentPassword: 'anything at all' }, cookie))

  assert.equal(res.status, 400, res.text)
  // Refused for what the account is rather than by falling through the password
  // comparison. `verifyPassword` answers false for the null salt and digest on
  // that row either way, so the door is shut both ways, and telling somebody with
  // no password that they got their password wrong is a message about an answer
  // they could never have typed.
  assert.doesNotMatch(res.body.error, /current password/i)
  assert.equal(
    (await call('/auth/me', cookie)).status,
    200,
    'the guest lost the only session their account has',
  )
  assert.equal(await liveSessions(guest.id), 1)
})
