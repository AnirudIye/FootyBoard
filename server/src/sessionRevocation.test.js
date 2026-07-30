import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, all, closePool } from './db.js'
import { createSession, hashPassword, COOKIE_NAME } from './auth.js'
import { hashAnswer } from './securityQuestions.js'
import { addressKey, answerKey } from './rateLimit.js'
import { testBoard } from './testBoard.js'

/**
 * Destroying a session closes the rooms it was holding.
 *
 * The defect this covers, exactly as it was found in two browsers: recovering a
 * password destroyed every session row, REST correctly refused the revoked
 * cookie from that moment on, and the WebSocket that cookie had already opened
 * carried on working. The owner moved a chip and the revoked session saw it;
 * the revoked session moved a chip and the owner saw that. The guarantee the
 * whole reset design rests on — that a stolen session cannot outlive the
 * password changed to stop it — was false for as long as the attacker left the
 * tab open, because a socket is authorized once at the handshake and never
 * again.
 *
 * **Two instances, and that is not decoration.** In one process the session
 * destruction and the socket share memory, so a single-instance test passes
 * whatever the code does about publishing. The deployed shape is a cluster,
 * where the instance serving the recovery request is almost certainly not the
 * one holding the victim's socket, and the eviction has to travel the same
 * Postgres LISTEN/NOTIFY bus every other cross-instance correction here uses.
 * So every eviction below is made on the instance that is *not* holding the
 * socket it has to close.
 *
 * Its own ports: `node --test` runs files concurrently and :8799 to :8806 are
 * spoken for. Landing on somebody else's pair does not fail loudly, which is
 * the trap: this file's instances die of EADDRINUSE, the requests are answered
 * perfectly well by the other suite's processes, and then that suite finishes
 * and kills them mid-run.
 */

const A = 8807
const B = 8808
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

const children = []
const users = []
const emails = []
let owner
let boardId
let otherBoardId

function startInstance(port) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), RUN_MAINTENANCE: 'false', INSTANCE_LABEL: `test-${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    if (!text.includes('ENCRYPTION_KEY')) process.stderr.write(`[${port}] ${text}`)
  })
  children.push(child)
  return child
}

/** Resolves with what the instance says about itself, so the pids can be compared. */
async function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return await res.json()
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`instance on :${port} never became healthy`)
}

/**
 * Every per-IP allowance this suite spends, cleared between tests.
 *
 * These are rows and rows outlive a test run, so a second run would otherwise
 * start partway through an allowance and collect a 429 that reads like a broken
 * limiter. Named exactly rather than swept by prefix, because something else is
 * using this database.
 */
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown']
const IP_KEYS = ['forgot-ip', 'answer-ip', 'reset-ip', 'signup', 'ip'].flatMap((prefix) =>
  LOOPBACK.map((ip) => `${prefix}:${ip}`),
)
const clearIpAllowances = async () => {
  for (const key of IP_KEYS) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

/**
 * A user with a real password and a real security answer, inserted directly.
 *
 * Not through `/signup`, so that tests which are not about signing up do not
 * spend that route's per-IP allowance, and both credentials are stored exactly
 * the way the routes store them so `/auth/password` and `/auth/forgot/verify`
 * can be driven for real.
 */
async function makeUser({ password = 'the-first-password', answer = 'Blue Sky' } = {}) {
  const id = randomUUID()
  const email = `${id}@test.invalid`
  const [secret, digest] = await Promise.all([hashPassword(password), hashAnswer(answer)])
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        security_question_id, security_answer_hash, security_answer_salt)
     VALUES ($1, $2, $3, $4, $5, $5, 'first-pet', $6, $7)`,
    id,
    email,
    secret.hash,
    secret.salt,
    new Date().toISOString(),
    digest.hash,
    digest.salt,
  )
  users.push(id)
  emails.push(email)
  return { id, email, password, answer }
}

/** Admitted directly: how somebody got into the room is another suite's subject. */
const addMember = (board, userId) =>
  run(
    `INSERT INTO board_members (board_id, user_id, joined_at) VALUES ($1, $2, $3)
     ON CONFLICT (board_id, user_id) DO NOTHING`,
    board,
    userId,
    new Date().toISOString(),
  )

const cookieFor = async (userId) => `${COOKIE_NAME}=${await createSession(userId)}`

const call = (port, path, cookie, init = {}) =>
  fetch(`http://127.0.0.1:${port}/api${path}`, {
    ...init,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const post = (port, path, body, cookie) =>
  call(port, path, cookie, { method: 'POST', body: JSON.stringify(body) })

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) })

const sessionCookie = (res) => {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))
  return set ? set.split(';')[0] : null
}

/**
 * A socket that remembers everything it was sent, and how it ended.
 *
 * Resolves on `welcome` rather than on `open`: the handshake completes before
 * the server has authorized anyone, so an open socket may still be a moment
 * away from being closed.
 */
async function openSocket(port, board, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`, {
    headers: { Cookie: cookie },
  })
  socket.received = []
  socket.closeInfo = null

  socket.on('message', (raw) => socket.received.push(JSON.parse(raw)))
  socket.on('close', (code, reason) => {
    socket.closeInfo = { code, reason: String(reason) }
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

/** Resolves with the first message matching `match`, or throws on timeout. */
function waitForMessage(socket, match, timeoutMs = 4000) {
  const already = socket.received.find(match)
  if (already) return Promise.resolve(already)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`no message matched within ${timeoutMs}ms`))
    }, timeoutMs)

    function onMessage(raw) {
      const message = JSON.parse(raw)
      if (!match(message)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

/** The close code the server chose, or a failure if it never closed. */
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

/**
 * Nothing matching arrived, given long enough for it to have.
 *
 * A negative across two processes needs a window rather than a tick: the op has
 * to have had time to cross the bus and be refused, or the assertion passes for
 * the wrong reason. Half a second is many times the round trip these tests
 * measure in the positive direction.
 */
async function nothingMatching(socket, match, ms = 500) {
  await new Promise((r) => setTimeout(r, ms))
  assert.deepEqual(socket.received.filter(match), [], 'a message arrived that should not have')
}

/** Sending on a socket the server has closed. The error is the point, not a failure. */
const trySend = (socket, message) =>
  new Promise((resolve) => {
    try {
      socket.send(JSON.stringify(message), () => resolve())
    } catch {
      resolve()
    }
  })

before(async () => {
  await migrate()
  await clearIpAllowances()
  startInstance(A)
  startInstance(B)
  const [first, second] = await Promise.all([waitForHealth(A), waitForHealth(B)])

  /**
   * Two processes, asserted rather than assumed.
   *
   * Everything in this file is about a socket and a session being on different
   * instances, and every one of those assertions passes trivially if they are
   * not. An instance that dies of EADDRINUSE leaves its port answered by
   * whoever already had it, so "both ports respond" is not the same question.
   */
  assert.notEqual(first.pid, second.pid, 'one process is answering both ports')

  owner = await makeUser()
  const ownerCookie = await cookieFor(owner.id)
  for (const name of ['Session board', 'Second board']) {
    const created = await json(
      await post(A, '/boards', { name, data: testBoard() }, ownerCookie),
    )
    assert.equal(created.status, 201)
    if (name === 'Session board') boardId = created.body.board.id
    else otherBoardId = created.body.board.id
  }
  owner.cookie = ownerCookie
})

beforeEach(clearIpAllowances)

after(async () => {
  for (const child of children) child.kill()
  for (const id of users) await run('DELETE FROM users WHERE id = $1', id)
  for (const email of emails) {
    for (const key of [answerKey(email), addressKey('forgot', email), `account:${email}`]) {
      await run('DELETE FROM login_attempts WHERE key = $1', key)
    }
  }
  await clearIpAllowances()
  await closePool()
})

test('recovering a password closes the revoked room on the instance holding it', async () => {
  const victim = await makeUser()
  await addMember(boardId, victim.id)
  const cookie = await cookieFor(victim.id)

  // The owner is on one instance and the victim on the other, so nothing below
  // can pass by sharing memory.
  const ownerSocket = await openSocket(A, boardId, owner.cookie)
  const victimSocket = await openSocket(B, boardId, cookie)

  // The room really is one room first, or "did not receive it" afterwards means
  // nothing at all.
  await waitForMessage(ownerSocket, (m) => m.type === 'peer-joined')
  ownerSocket.send(JSON.stringify({ type: 'patch', entity: 'token', id: 't1', patch: { x: 42.08, y: 38.13 } }))
  const before = await waitForMessage(victimSocket, (m) => m.type === 'patch')
  assert.deepEqual(before.patch, { x: 42.08, y: 38.13 })

  // Recovery, on the instance that is not holding the victim's socket.
  const asked = await json(await post(A, '/auth/forgot', { email: victim.email }))
  assert.equal(asked.status, 200)
  assert.equal(asked.body.question.id, 'first-pet')

  const verified = await json(
    await post(A, '/auth/forgot/verify', { email: victim.email, answer: victim.answer }),
  )
  assert.equal(verified.status, 200)

  const done = await json(
    await post(A, '/auth/reset', { token: verified.body.token, password: 'a-brand-new-password' }),
  )
  assert.equal(done.status, 200)
  assert.equal((await all('SELECT id FROM sessions WHERE user_id = $1', victim.id)).length, 0)

  // 1. The socket is closed, by an instance that never served the reset.
  assert.equal(await waitForClose(victimSocket), 4401)

  // REST refused it before this fix too. The socket is the half that did not.
  assert.equal((await call(B, '/auth/me', cookie)).status, 401)
  assert.equal((await call(B, '/boards', cookie)).status, 401)

  // 2. Read access is gone: what the owner does next never reaches them. This
  //    is the observation the defect was reported from.
  ownerSocket.send(JSON.stringify({ type: 'patch', entity: 'token', id: 't2', patch: { x: 9, y: 9 } }))
  await nothingMatching(victimSocket, (m) => m.type === 'patch' && m.id === 't2')

  // 3. And write access with it: an op emitted from the revoked session does
  //    not reach the room.
  await trySend(victimSocket, { type: 'patch', entity: 'token', id: 't3', patch: { x: 1, y: 1 } })
  await nothingMatching(ownerSocket, (m) => m.type === 'patch' && m.id === 't3')

  // The cookie cannot open a new room either, which is `userForToken` doing its
  // half rather than the eviction doing it twice.
  await assert.rejects(
    () => openSocket(B, boardId, cookie),
    (err) => err.code === 4401,
  )

  // The eviction is server bookkeeping and stops at the relay. A client's
  // message handler treats anything it does not recognise as a board op, so
  // handing it one would be worse than merely wasteful.
  assert.equal(
    ownerSocket.received.some((m) => m.type === 'evict-session'),
    false,
    'an internal control message reached a browser',
  )

  ownerSocket.close()
})

test('changing the password keeps the session it mints and evicts the rest', async () => {
  const person = await makeUser({ password: 'the-first-password' })
  await addMember(boardId, person.id)
  const mine = await cookieFor(person.id)
  const elsewhere = await cookieFor(person.id)

  // The browser doing the change is on A; the other one is on B, so its
  // eviction has to cross the bus.
  const mySocket = await openSocket(A, boardId, mine)
  const theirSocket = await openSocket(B, boardId, elsewhere)

  const res = await post(
    A,
    '/auth/password',
    {
      currentPassword: 'the-first-password',
      password: 'the-second-password',
      securityQuestionId: 'first-club',
      securityAnswer: 'Red Sky',
    },
    mine,
  )
  assert.equal(res.status, 200)

  // Exactly one session survives, and it is the one this response is handing
  // back. Everything the destroyed ones were holding is closed, the caller's
  // own included: that session is gone too, so sparing its socket would be the
  // same hole reached from the friendlier direction.
  assert.equal((await all('SELECT id FROM sessions WHERE user_id = $1', person.id)).length, 1)
  assert.equal(await waitForClose(theirSocket), 4401, 'the other browser kept its room')
  assert.equal(await waitForClose(mySocket), 4401, 'the replaced session kept its room')

  assert.equal((await call(B, '/auth/me', elsewhere)).status, 401)
  assert.equal((await call(B, '/auth/me', mine)).status, 401)

  // And the replacement is untouched by the eviction that took the others, on
  // an instance that only ever heard about it over the bus.
  const replacement = sessionCookie(res)
  assert.ok(replacement, 'no replacement session came back')
  assert.equal((await call(B, '/auth/me', replacement)).status, 200)

  const reconnected = await openSocket(B, boardId, replacement)
  assert.ok(reconnected.received.find((m) => m.type === 'welcome'))
  reconnected.close()
})

test('signing out of one browser leaves the other one in the room', async () => {
  const person = await makeUser()
  await addMember(boardId, person.id)
  const laptop = await cookieFor(person.id)
  const tablet = await cookieFor(person.id)

  const ownerSocket = await openSocket(A, boardId, owner.cookie)
  const laptopSocket = await openSocket(B, boardId, laptop)
  const tabletSocket = await openSocket(B, boardId, tablet)

  // Signed out on the instance holding neither socket.
  assert.equal((await post(A, '/auth/logout', {}, tablet)).status, 204)

  assert.equal(await waitForClose(tabletSocket), 4401)

  // The point of matching on the session rather than the user: signing out of
  // the tablet must not close the laptop somebody is presenting from.
  assert.equal(laptopSocket.closeInfo, null, 'an unrelated session was evicted too')
  ownerSocket.send(JSON.stringify({ type: 'patch', entity: 'token', id: 't4', patch: { x: 5, y: 5 } }))
  const still = await waitForMessage(laptopSocket, (m) => m.type === 'patch' && m.id === 't4')
  assert.deepEqual(still.patch, { x: 5, y: 5 })
  assert.equal((await call(B, '/auth/me', laptop)).status, 200)

  ownerSocket.close()
  laptopSocket.close()
})

test('deleting the account closes every room that session was in', async () => {
  const person = await makeUser()
  await addMember(boardId, person.id)
  await addMember(otherBoardId, person.id)
  const cookie = await cookieFor(person.id)

  // Two rooms on one instance, because the message carries no board and the
  // sweep has to be over all of them. Boards cascade from the user row and
  // these two do not: they are somebody else's, and being deleted is no reason
  // to keep editing them.
  const first = await openSocket(B, boardId, cookie)
  const second = await openSocket(B, otherBoardId, cookie)

  // The current password rides along because deletion asks for it now, on the
  // argument `/password` and `/sessions` already made: a held session must not
  // be enough for the one thing nothing undoes. What this test is about is
  // unchanged, which is that the rooms close when the account goes.
  assert.equal(
    (
      await call(A, '/auth/me', cookie, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: person.password }),
      })
    ).status,
    204,
  )

  assert.equal(await waitForClose(first), 4401)
  assert.equal(await waitForClose(second), 4401)
})

test('a client cannot forge an eviction', async () => {
  const person = await makeUser()
  await addMember(boardId, person.id)
  const cookie = await cookieFor(person.id)

  const ownerSocket = await openSocket(A, boardId, owner.cookie)
  const memberSocket = await openSocket(B, boardId, cookie)

  const live = await all('SELECT id FROM sessions WHERE user_id = $1', owner.id)
  assert.ok(live.length > 0)

  // Refused as a message the server alone may send, so it is neither acted on
  // nor relayed onward as an unrecognised board op.
  await trySend(memberSocket, { type: 'evict-session', sessionIds: live.map((r) => r.id) })
  await nothingMatching(ownerSocket, (m) => m.type === 'evict-session')
  assert.equal(ownerSocket.closeInfo, null, 'a member threw the owner out of their own board')

  ownerSocket.close()
  memberSocket.close()
})
