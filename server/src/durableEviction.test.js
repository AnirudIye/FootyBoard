import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, all, closePool } from './db.js'
import { createSession, hashPassword, COOKIE_NAME } from './auth.js'
import { hashAnswer } from './securityQuestions.js'
import { addressKey, answerKey } from './rateLimit.js'
import { destroyAllSessions, purgeExpiredRevocations, REVOCATION_RETENTION_MS } from './sessions.js'
import { LISTENER_RETRY_MS } from './realtime.js'
import { testBoard } from './testBoard.js'

/**
 * An eviction survives the bus that was supposed to carry it.
 *
 * `sessionRevocation.test.js` covers the happy path: destroy a session on one
 * instance and the socket it authorized closes on another, because the
 * `evict-session` NOTIFY got there. This file covers the case that NOTIFY is
 * not enough for. A socket is authorized once, at the handshake, and never
 * re-checked, so the message is the *only* thing that closes it — and an
 * instance whose LISTEN connection is down when the message is published never
 * hears it. The session row is gone everywhere, because that is one committed
 * transaction, so REST answers 401 on every instance while a socket on the
 * instance that missed the message keeps its room until it happens to
 * disconnect. A bus outage during a password reset is precisely when that
 * matters: a reset is the control somebody reaches for when they believe
 * another person is in their account.
 *
 * **The bus is really dropped, and that is the whole point of the file.**
 * Asserting that a row appears in `session_revocations` would prove nothing
 * about the case this exists for, because the row is not the guarantee — the
 * socket closing is. So the far instance's Postgres connections are terminated
 * from underneath it, the revocation is made on the near instance while they
 * are gone, and the far socket is then asserted to be *still open*. That
 * negative is what makes the positive afterwards mean something: without it, a
 * termination that had not taken effect yet would let the NOTIFY through and
 * this file would pass against exactly the code it exists to fail.
 *
 * The far instance is found by `application_name`, which is set for it alone
 * through `PGAPPNAME`, so nothing here can reach another suite's processes.
 * Both its pooled connections and its LISTEN connection go, which is the
 * faithful outage rather than a blunter one: a Postgres restart takes every
 * connection an instance holds, not just the interesting one.
 *
 * Its own ports, because `node --test` runs files concurrently and :8799 to
 * :8814 are spoken for. Landing on somebody else's pair does not fail loudly:
 * this file's instances die of EADDRINUSE, the requests are answered perfectly
 * well by the other suite's processes, and then that suite finishes and kills
 * them mid-run.
 */

const A = 8815
const B = 8816
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/**
 * What the far instance calls itself to Postgres.
 *
 * `pg` reads `PGAPPNAME` off the environment, so setting it on the child names
 * every connection that child opens without a line of production code that
 * exists for a test. It is what makes "drop the bus" mean *this* instance's bus
 * rather than every connection in the dev database.
 */
const APP_NAME = (port) => `footyboard-test-${port}`

/**
 * A documentation-range address, so this suite owns its own rate-limit bucket.
 *
 * Every suite reaches the API from 127.0.0.1, so the per-IP allowances are one
 * counter shared by the whole concurrent run. Declaring a proxy and sending a
 * TEST-NET-3 address is the same mechanism `npm run cluster` uses, and it means
 * a neighbour spending the recovery allowance cannot turn the reset below into
 * a 429 that reads like a broken reset.
 */
const SUITE_IP = '203.0.113.15'

/**
 * How long "the bus is still down" is asserted for.
 *
 * Derived from the reconnect interval rather than picked to look safe: the
 * assertion has to land before the far instance's listener comes back, and that
 * interval is the entire budget. A NOTIFY that did get through would have
 * arrived in single-digit milliseconds, since it is already committed by the
 * time the revoking request answers, so a fraction of the interval is a
 * generous negative and still nowhere near the deadline.
 */
const WHILE_DOWN_MS = Math.floor(LISTENER_RETRY_MS / 8)

/** The reconnect, plus room for a machine running fifteen suites at once. */
const RECONCILE_MS = LISTENER_RETRY_MS + 15_000

/**
 * Every per-IP allowance the reset below spends, named exactly and cleared
 * first.
 *
 * Owning the address is not the same as owning the count. `forgot-ip` and
 * `reset-ip` allow twenty an hour and these are rows, so they outlive a run:
 * the twenty-first run inside an hour would collect a 429 that reads exactly
 * like a broken reset. Named one at a time rather than swept by prefix, because
 * a `LIKE 'forgot-ip:%'` here would reach into whichever neighbour was in the
 * middle of counting — which is a live problem in this suite already, see the
 * note in `handoff.md` under the port list.
 */
const IP_KEYS = ['forgot-ip', 'answer-ip', 'reset-ip'].map((prefix) => `${prefix}:${SUITE_IP}`)
const clearIpAllowances = async () => {
  for (const key of IP_KEYS) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

const children = []
const users = []
const emails = []
let owner
let boardId

function startInstance(port) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${port}`,
      PGAPPNAME: APP_NAME(port),
      // Without this `req.ip` is the socket address and every suite shares it.
      // See SUITE_IP.
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    // The instance whose connections are pulled out from under it says so, at
    // length. That is the subject of this file rather than a symptom of
    // something wrong, so it is not worth printing.
    if (/ENCRYPTION_KEY|terminating connection|LISTEN connection error/.test(text)) return
    process.stderr.write(`[${port}] ${text}`)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Take every Postgres connection one instance holds, and wait for Postgres to
 * agree that they are gone.
 *
 * The waiting is the part that matters. `pg_terminate_backend` reports that the
 * signal was sent, not that the backend has died, and a backend that is still
 * registered is still delivered notifications — so revoking immediately after
 * the call would race the very thing this file is trying to demonstrate. Once
 * no row remains, the database has no listener for that instance and a NOTIFY
 * committed afterwards cannot reach it, which is a fact about Postgres rather
 * than a hope about timing.
 */
async function dropBusOn(port, timeoutMs = 10_000) {
  const appName = APP_NAME(port)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await all(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      appName,
    )
    const live = await all('SELECT pid FROM pg_stat_activity WHERE application_name = $1', appName)
    if (live.length === 0) return
    await sleep(25)
  }
  throw new Error(`the connections held by :${port} never went away`)
}

/** Whether the far instance has re-established its LISTEN connection. */
async function busIsBackOn(port, timeoutMs = RECONCILE_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = await all(
      'SELECT pid FROM pg_stat_activity WHERE application_name = $1',
      APP_NAME(port),
    )
    if (live.length > 0) return true
    await sleep(50)
  }
  return false
}

/**
 * A user with a real password and a real security answer, inserted directly.
 *
 * Not through `/signup`, so a suite that is not about signing up does not spend
 * that route's allowance, and both credentials are stored exactly the way the
 * routes store them so recovery can be driven for real.
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
      'X-Forwarded-For': SUITE_IP,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const post = (port, path, body, cookie) =>
  call(port, path, cookie, { method: 'POST', body: JSON.stringify(body) })

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) })

/** A socket that remembers everything it was sent, and how it ended. */
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
function waitForClose(socket, timeoutMs) {
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

/** Nothing matching arrived, given long enough for it to have. */
async function nothingMatching(socket, match, ms = 500) {
  await sleep(ms)
  assert.deepEqual(socket.received.filter(match), [], 'a message arrived that should not have')
}

before(async () => {
  await migrate()
  await clearIpAllowances()
  startInstance(A)
  startInstance(B)
  const [first, second] = await Promise.all([waitForHealth(A), waitForHealth(B)])

  // Everything here is about a socket and a revocation being in different
  // processes, and every one of those assertions passes trivially if they are
  // not. An instance that died of EADDRINUSE leaves its port answered by
  // whoever already had it, so "both ports respond" is a different question.
  assert.notEqual(first.pid, second.pid, 'one process is answering both ports')

  owner = await makeUser()
  owner.cookie = await cookieFor(owner.id)
  const created = await json(
    await post(A, '/boards', { name: 'Durable eviction board', data: testBoard() }, owner.cookie),
  )
  assert.equal(created.status, 201)
  boardId = created.body.board.id
})

after(async () => {
  for (const child of children) child.kill()
  for (const id of users) {
    // Scoped to this suite's own rows: something else is using this database.
    // Revocations do not cascade from `users` on purpose — see the table's
    // comment in `db.js` — so they are removed by hand here.
    await run('DELETE FROM session_revocations WHERE user_id = $1', id)
    await run('DELETE FROM users WHERE id = $1', id)
  }
  for (const email of emails) {
    for (const key of [answerKey(email), addressKey('forgot', email)]) {
      await run('DELETE FROM login_attempts WHERE key = $1', key)
    }
  }
  await clearIpAllowances()
  await closePool()
})

test('a reset made while the bus is down still closes the far room', async () => {
  const victim = await makeUser()
  await addMember(boardId, victim.id)
  const cookie = await cookieFor(victim.id)

  // The owner is on the instance that will serve the reset; the victim is on
  // the one whose bus is about to disappear.
  const ownerSocket = await openSocket(A, boardId, owner.cookie)
  const victimSocket = await openSocket(B, boardId, cookie)

  // The room really is one room across the two, or "did not receive it" later
  // means nothing at all.
  await waitForMessage(ownerSocket, (m) => m.type === 'peer-joined')
  ownerSocket.send(
    JSON.stringify({ type: 'patch', entity: 'token', id: 'd1', patch: { x: 42.08, y: 38.13 } }),
  )
  const before = await waitForMessage(victimSocket, (m) => m.type === 'patch')
  assert.deepEqual(before.patch, { x: 42.08, y: 38.13 })

  // Everything slow about recovery happens while the bus is up, so that only
  // the step that actually destroys the sessions has to fit in the window
  // below. Two scrypt digests inside it would be measuring the wrong thing.
  const asked = await json(await post(A, '/auth/forgot', { email: victim.email }))
  assert.equal(asked.status, 200)
  const verified = await json(
    await post(A, '/auth/forgot/verify', { email: victim.email, answer: victim.answer }),
  )
  assert.equal(verified.status, 200)

  await dropBusOn(B)

  const done = await json(
    await post(A, '/auth/reset', { token: verified.body.token, password: 'a-brand-new-password' }),
  )
  assert.equal(done.status, 200)
  assert.equal((await all('SELECT id FROM sessions WHERE user_id = $1', victim.id)).length, 0)

  // The durable half exists. Not the guarantee — the socket closing is — but
  // the eviction has to have been written down or there is nothing to catch up
  // with, and a failure here says which half is missing.
  const recorded = await all(
    'SELECT session_id FROM session_revocations WHERE user_id = $1',
    victim.id,
  )
  assert.equal(recorded.length, 1, 'the revocation was not recorded')

  // **The message was genuinely lost.** If the far instance were still on the
  // bus it would have closed this socket within a millisecond or two of the
  // response above, so an open socket here is what proves the outage is real
  // and that anything after it is reconciliation rather than the NOTIFY.
  await sleep(WHILE_DOWN_MS)
  assert.equal(
    victimSocket.closeInfo,
    null,
    'the eviction crossed the bus after all, so this proves nothing',
  )
  // And REST is already refusing it, which is the half that never needed the bus.
  assert.equal((await call(B, '/auth/me', cookie)).status, 401)

  // The bus comes back on its own, and the instance catches up with what it
  // missed while it was away.
  assert.ok(await busIsBackOn(B), 'the far instance never reconnected')
  assert.equal(await waitForClose(victimSocket, RECONCILE_MS), 4401)

  // Read access is gone with it: what the owner does next never arrives.
  ownerSocket.send(
    JSON.stringify({ type: 'patch', entity: 'token', id: 'd2', patch: { x: 9, y: 9 } }),
  )
  await nothingMatching(victimSocket, (m) => m.type === 'patch' && m.id === 'd2')

  // Reconciliation is server bookkeeping and stops at the relay, exactly as the
  // bus-borne eviction does: a client's message handler treats anything it does
  // not recognise as a board op.
  assert.equal(
    ownerSocket.received.some((m) => m.type === 'evict-session'),
    false,
    'an internal control message reached a browser',
  )

  ownerSocket.close()
})

test('a revocation that cannot be recorded takes the whole change down with it', async () => {
  const person = await makeUser()
  const cookie = await cookieFor(person.id)
  const [session] = await all('SELECT id FROM sessions WHERE user_id = $1', person.id)

  /**
   * The one way to make the statement fail *after* the delete has happened.
   *
   * A revocation already claiming this session's id collides with the primary
   * key, which is unreachable in ordinary use — ids are uuids and a session is
   * destroyed once — and is the only lever that exercises the requirement: the
   * row and the deletion are one statement, so neither can commit without the
   * other. The direction this proves is the cheap one to observe; the direction
   * that matters, a durable record of an eviction that never happened, is the
   * same transaction boundary read the other way round.
   */
  await run(
    'INSERT INTO session_revocations (session_id, user_id, revoked_at) VALUES ($1, $2, $3)',
    session.id,
    person.id,
    Date.now(),
  )

  await assert.rejects(() =>
    destroyAllSessions(async (client) => {
      // Stands in for the password change every real caller makes here. It has
      // to be rolled back too, or a failure leaves a changed credential with
      // the sessions it was changed to end still live.
      await client.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Rolled Back', person.id])
      return person.id
    }),
  )

  const [user] = await all('SELECT display_name FROM users WHERE id = $1', person.id)
  assert.equal(user.display_name, null, 'the change committed without its revocation')
  assert.equal(
    (await all('SELECT id FROM sessions WHERE user_id = $1', person.id)).length,
    1,
    'a session was destroyed without the eviction being recorded',
  )
  assert.equal((await call(A, '/auth/me', cookie)).status, 200)
})

test('a revocation older than any session could be is swept', async () => {
  const person = await makeUser()
  const stale = randomUUID()
  const recent = randomUUID()

  for (const [id, at] of [
    [stale, Date.now() - REVOCATION_RETENTION_MS - 1000],
    [recent, Date.now()],
  ]) {
    await run(
      'INSERT INTO session_revocations (session_id, user_id, revoked_at) VALUES ($1, $2, $3)',
      id,
      person.id,
      at,
    )
  }

  await purgeExpiredRevocations()

  const left = await all(
    'SELECT session_id FROM session_revocations WHERE user_id = $1',
    person.id,
  )
  assert.deepEqual(
    left.map((row) => row.session_id),
    [recent],
  )
})
