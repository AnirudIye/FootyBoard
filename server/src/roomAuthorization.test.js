import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, all, get, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { LISTENER_RETRY_MS, MESSAGE_TYPES, safeLabel } from './realtime.js'
import { guestMintingKey, MAX_GUESTS_PER_SHARE } from './routes/shares.js'
import { testBoard } from './testBoard.js'

/**
 * What a room may be told, and what it keeps believing after it is told wrong.
 *
 * Four claims, and they are all the same claim from different sides: **a socket
 * is authorized once, at the handshake, and the only things that can correct it
 * afterwards are the ones this file exercises.**
 *
 *  - A client cannot originate a server control message. The room's anonymity is
 *    the sharpest case, because forging it does not merely lie to an interface:
 *    it rewrites the cache every other instance names people out of, so real
 *    addresses start travelling to peers who were promised none would.
 *  - Removing a member closes their socket even if the notification bus was down
 *    when it happened, exactly as destroying a session already does.
 *  - Deleting a board closes the room it was authorized against.
 *  - The two cached per-room flags are corrected rather than believed forever,
 *    because the bus is the only thing that ever changed them and a bus can be
 *    missed.
 *
 * Two instances, like every other realtime suite here, so that a control message
 * really does travel through Postgres LISTEN/NOTIFY rather than passing locally
 * inside one process. Where a bus outage is the subject, the far instance's
 * connections are terminated from underneath it and the *negative* is asserted
 * first — the socket is still open, the room is still stale — because without
 * that a termination which had not taken effect yet would let the NOTIFY through
 * and every assertion afterwards would pass against exactly the code this file
 * exists to fail.
 *
 * Its own ports: `node --test` runs files concurrently and :8799 to :8819 are
 * spoken for. Landing on somebody else's pair does not fail loudly, it makes
 * this file's instances die of EADDRINUSE while their requests are answered
 * perfectly well by the neighbour that already had the port.
 */

const A = 8820
const B = 8821
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/**
 * What the far instance calls itself to Postgres.
 *
 * `pg` reads `PGAPPNAME` off the environment, so setting it on the child names
 * every connection that child opens without a line of production code existing
 * for a test. It is what makes "drop the bus" mean *this* instance's bus rather
 * than every connection in the dev database.
 */
const APP_NAME = (port) => `footyboard-test-${port}`

/**
 * A documentation-range address, so this suite owns the allowances it spends.
 *
 * Every suite reaches the API from 127.0.0.1, so the per-IP allowances are one
 * counter shared by the whole concurrent run. Declaring a proxy and sending a
 * TEST-NET-3 address is the same mechanism `npm run cluster` uses. Above .200
 * because `rateLimit.test.js` writes `ip:203.0.113.N` for a random N up to 200,
 * and .222 because .217 to .221 and .7 and .15 are already claimed.
 */
const SUITE_IP = '203.0.113.222'

/** Exactly the keys this file's own requests charge. Never a prefix. */
const OWN_ALLOWANCE_KEYS = [`join:${SUITE_IP}`, `share:${SUITE_IP}`]
const clearOwnAllowances = async () => {
  for (const key of OWN_ALLOWANCE_KEYS) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

/**
 * How long "the bus is still down" is asserted for.
 *
 * Derived from the reconnect interval rather than picked to look safe: the
 * assertion has to land before the far instance's listener comes back, and that
 * interval is the entire budget. Anything that did cross the bus would have
 * arrived in single-digit milliseconds, since it is already committed by the
 * time the request that published it answers.
 */
const WHILE_DOWN_MS = Math.floor(LISTENER_RETRY_MS / 8)

/** The reconnect, plus room for a machine running twenty suites at once. */
const RECONCILE_MS = LISTENER_RETRY_MS + 15_000

/** Long enough for a NOTIFY to have crossed, if one was ever going to. */
const CROSSED_MS = 600

const ANONYMOUS_NAME = /^Anonymous [A-Z][a-z]+$/

const children = []
const users = []
const boards = []
/** Allowance rows this file writes on keys of its own, cleared by exact name. */
const allowanceKeys = []

function startInstance(port) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${port}`,
      PGAPPNAME: APP_NAME(port),
      // Without this `req.ip` is the socket address and every suite shares it.
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    // The instance whose connections are pulled out from under it says so, at
    // length. That is the subject of this file rather than a symptom of
    // something wrong, so it is not worth printing.
    if (/ENCRYPTION_KEY|terminating connection|LISTEN connection error|Not published/.test(text)) return
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
 * registered is still delivered notifications — so publishing immediately after
 * the call would race the very thing this file is trying to demonstrate.
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

/** A signed-in user, without going through the IP-rate-limited signup route. */
async function makeUser() {
  const id = randomUUID()
  const email = `${id}@test.invalid`
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, 'x', 'x', $3, $3)`,
    id,
    email,
    new Date().toISOString(),
  )
  users.push(id)
  return { id, email, cookie: `${COOKIE_NAME}=${await createSession(id)}` }
}

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

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) })

/** A board of `owner`'s with `members` already on it, and nobody's room open. */
async function makeBoard(name, members = []) {
  const created = await json(
    await call(A, '/boards', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ name, data: testBoard() }),
    }),
  )
  assert.equal(created.status, 201)
  const id = created.body.board.id
  boards.push(id)

  // Admitted directly rather than through a code: how somebody got into the
  // room is another suite's subject, and redeeming spends an allowance.
  for (const member of members) {
    await run(
      `INSERT INTO board_members (board_id, user_id, joined_at) VALUES ($1, $2, $3)
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      id,
      member.id,
      new Date().toISOString(),
    )
  }
  return id
}

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

const closed = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve()
    socket.once('close', resolve)
    socket.close()
  })

/**
 * How this room currently introduces `speaker` to the peers beside them.
 *
 * Every assertion about anonymity here goes through an introduction rather than
 * through a cache nothing outside the process can read, and that is deliberate:
 * the name in the payload is the whole feature, and the cache is only how the
 * instance arrives at it. `here` is answered with `peer-present`, which is built
 * by whichever instance holds the speaker's socket, so this asks that instance
 * what it currently believes.
 */
async function introduce(speaker, listener, timeoutMs = 4000) {
  // Counted rather than matched on content. The interesting assertions ask
  // whether an answer *changed*, so a filter keyed on what the message says
  // cannot tell a second identical introduction from the first one and waits
  // out its whole timeout on the case where nothing moved.
  const already = listener.received.filter((m) => m.type === 'peer-present').length
  speaker.send(JSON.stringify({ type: 'here' }))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const seen = listener.received.filter((m) => m.type === 'peer-present')
    if (seen.length > already) return seen[already]
    await sleep(25)
  }
  throw new Error(`no introduction arrived within ${timeoutMs}ms`)
}

let owner
let guest
let other

before(async () => {
  await migrate()
  await clearOwnAllowances()
  startInstance(A)
  startInstance(B)
  const [first, second] = await Promise.all([waitForHealth(A), waitForHealth(B)])

  // Everything here is about a socket and a change being in different processes,
  // and every one of those assertions passes trivially if they are not.
  assert.notEqual(first.pid, second.pid, 'one process is answering both ports')

  /**
   * The instances answering are the ones this file started.
   *
   * A child that lost the race for its port dies of EADDRINUSE and its requests
   * are then answered perfectly well by whoever already had the port, so "both
   * ports respond" is a different question from "our processes are up". Every
   * assertion below would be made against a stranger, and the ones resting on a
   * bus outage would pass without proving anything, because the process whose
   * connections were terminated is not the one being asked. Windows holds a
   * listening port for a moment after the process using it goes, so this is
   * reachable simply by running the suite twice in quick succession.
   */
  for (const child of children) {
    assert.equal(
      child.exitCode,
      null,
      'an instance this file started is already dead, most likely EADDRINUSE: something else is on :8820 or :8821',
    )
  }
  ;[owner, guest, other] = await Promise.all([makeUser(), makeUser(), makeUser()])
})

after(async () => {
  for (const child of children) child.kill()
  // Scoped to this suite's own rows: something else is using this database.
  // Member revocations do not cascade from `boards` or `users`, for the reason
  // written on the table, so they are removed by hand here.
  for (const id of boards) {
    // Guests this file admitted are accounts of their own and outlive the board
    // they were made for, so they go before it does.
    await run(
      `DELETE FROM users WHERE is_guest
        AND id IN (SELECT user_id FROM board_members WHERE board_id = $1)`,
      id,
    ).catch(() => {})
    await run('DELETE FROM board_member_revocations WHERE board_id = $1', id).catch(() => {})
  }
  for (const id of users) await run('DELETE FROM users WHERE id = $1', id)
  for (const key of allowanceKeys) await run('DELETE FROM login_attempts WHERE key = $1', key)
  await clearOwnAllowances()
  await closePool()
})

test('a client cannot forge the anonymity flip that hides addresses', async () => {
  const boardId = await makeBoard('Forged anonymity', [guest, other])
  const set = await json(
    await call(A, `/boards/${boardId}/anonymous`, owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ anonymous: true }),
    }),
  )
  assert.equal(set.status, 200)

  // Two sockets on A so that A relays locally, and the forger on B so the
  // message has to cross the bus to reach A at all — which is the path that
  // rewrites another instance's cache.
  const listener = await openSocket(A, boardId, other.cookie)
  const speaker = await openSocket(A, boardId, owner.cookie)
  const forger = await openSocket(B, boardId, guest.cookie)

  // The room is anonymous before the forgery, or "still anonymous" afterwards
  // means nothing at all.
  const honest = await introduce(speaker, listener)
  assert.match(honest.displayName, ANONYMOUS_NAME, 'the room was not anonymous to begin with')

  forger.send(JSON.stringify({ type: 'anon', anonymous: false }))
  await sleep(CROSSED_MS)

  const after = await introduce(speaker, listener)
  assert.match(
    after.displayName,
    ANONYMOUS_NAME,
    'a member turned the owner-only anonymity switch off for every other instance',
  )
  assert.equal(
    JSON.stringify(listener.received).includes('@'),
    false,
    'an address reached a client',
  )

  // And the control message itself stops at the relay, wherever it came from.
  for (const socket of [listener, speaker, forger]) {
    assert.equal(
      socket.received.some((m) => m.type === 'anon'),
      false,
      'an internal control message reached a browser',
    )
  }

  await Promise.all([closed(listener), closed(speaker), closed(forger)])
})

test('a removal made while the bus is down still closes the far room', async () => {
  const boardId = await makeBoard('Durable removal', [guest])

  const ownerSocket = await openSocket(A, boardId, owner.cookie)
  const victimSocket = await openSocket(B, boardId, guest.cookie)

  // The room really is one room across the two, or "did not receive it" later
  // means nothing at all.
  await waitForMessage(ownerSocket, (m) => m.type === 'peer-joined')
  ownerSocket.send(
    JSON.stringify({ type: 'patch', entity: 'token', id: 'r1', patch: { x: 12.5, y: 44.25 } }),
  )
  const crossed = await waitForMessage(victimSocket, (m) => m.type === 'patch')
  assert.deepEqual(crossed.patch, { x: 12.5, y: 44.25 })

  await dropBusOn(B)

  const removed = await json(
    await call(A, `/boards/${boardId}/members/${guest.id}`, owner.cookie, { method: 'DELETE' }),
  )
  assert.equal(removed.status, 204)

  // The durable half exists. Not the guarantee — the socket closing is — but
  // the eviction has to have been written down or there is nothing to catch up
  // with, and a failure here says which half is missing.
  const recorded = await all(
    'SELECT user_id FROM board_member_revocations WHERE board_id = $1',
    boardId,
  )
  assert.deepEqual(
    recorded.map((row) => row.user_id),
    [guest.id],
    'the removal was not recorded',
  )

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
  // And REST is already refusing them, which is the half that never needed the bus.
  assert.equal((await call(B, `/boards/${boardId}`, guest.cookie)).status, 404)

  // The bus comes back on its own, and the instance catches up with what it
  // missed while it was away.
  assert.ok(await busIsBackOn(B), 'the far instance never reconnected')
  assert.equal(await waitForClose(victimSocket, RECONCILE_MS), 4403)

  // Read access went with it: what the owner does next never arrives.
  ownerSocket.send(
    JSON.stringify({ type: 'patch', entity: 'token', id: 'r2', patch: { x: 9, y: 9 } }),
  )
  await sleep(CROSSED_MS)
  assert.equal(
    victimSocket.received.some((m) => m.type === 'patch' && m.id === 'r2'),
    false,
    'an evicted socket was still being relayed the room',
  )

  await closed(ownerSocket)
})

test('a member who rejoins before the catch-up is not thrown out by it', async () => {
  const boardId = await makeBoard('Rejoined in the gap', [guest])

  await json(
    await call(A, `/boards/${boardId}/members/${guest.id}`, owner.cookie, { method: 'DELETE' }),
  )
  // Put back the way the owner would: the revocation is still sitting there,
  // newer than any watermark a catching-up instance holds, and replaying it
  // against somebody who is a member again would close a socket that is
  // perfectly entitled to be open.
  await run(
    `INSERT INTO board_members (board_id, user_id, joined_at) VALUES ($1, $2, $3)
     ON CONFLICT (board_id, user_id) DO NOTHING`,
    boardId,
    guest.id,
    new Date().toISOString(),
  )

  const socket = await openSocket(B, boardId, guest.cookie)
  await dropBusOn(B)
  assert.ok(await busIsBackOn(B), 'the far instance never reconnected')

  await sleep(CROSSED_MS)
  assert.equal(socket.closeInfo, null, 'a revocation that had been undone was replayed')

  await closed(socket)
})

test('the anonymity a room missed while its bus was down is corrected', async () => {
  const boardId = await makeBoard('Missed the flip', [guest, other])

  // Both sockets on B, so B relays the introduction locally: with its bus down
  // it cannot publish either, so a socket on A would hear nothing whatever B
  // believed.
  const speaker = await openSocket(B, boardId, guest.cookie)
  const listener = await openSocket(B, boardId, other.cookie)

  const before = await introduce(speaker, listener)
  assert.equal(before.displayName, guest.email, 'the board was not naming people normally')

  await dropBusOn(B)
  const set = await json(
    await call(A, `/boards/${boardId}/anonymous`, owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ anonymous: true }),
    }),
  )
  assert.equal(set.status, 200)

  // **The message was genuinely lost**, so what follows is the room correcting
  // itself rather than the broadcast arriving late.
  await sleep(WHILE_DOWN_MS)
  const stale = await introduce(speaker, listener)
  assert.equal(stale.displayName, guest.email, 'the flip crossed the bus, so this proves nothing')

  assert.ok(await busIsBackOn(B), 'the far instance never reconnected')

  /**
   * Polled for the correction rather than slept on.
   *
   * `busIsBackOn` watches Postgres for a connection carrying this instance's
   * name, and the pooled ones come back too, so it can be true a moment before
   * the LISTEN client has reopened and re-read the row. Asking again is also
   * exactly how a person would find out, and the effect is the only thing
   * reachable from out here: the cache itself is inside another process.
   */
  let corrected = null
  const deadline = Date.now() + RECONCILE_MS
  while (Date.now() < deadline && corrected === null) {
    const named = await introduce(speaker, listener)
    if (ANONYMOUS_NAME.test(named.displayName)) corrected = named
    else await sleep(150)
  }
  assert.ok(corrected, 'the room went on serving addresses on a board that hides them')

  await Promise.all([closed(speaker), closed(listener)])
})

test('a removed member cannot walk back in with the code they already have', async () => {
  await clearOwnAllowances()
  const boardId = await makeBoard('Removed and returning')

  const share = await json(
    await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }),
  )
  assert.equal(share.status, 201)
  const code = share.body.share.code

  const joined = await json(
    await call(B, '/shares/join', guest.cookie, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  )
  assert.equal(joined.status, 200)

  const removed = await json(
    await call(A, `/boards/${boardId}/members/${guest.id}`, owner.cookie, { method: 'DELETE' }),
  )
  assert.equal(removed.status, 204)

  const again = await json(
    await call(B, '/shares/join', guest.cookie, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  )
  assert.equal(again.status, 403, 'the code let a removed member straight back in')

  const membership = await get(
    'SELECT count(*)::int AS n FROM board_members WHERE board_id = $1 AND user_id = $2',
    boardId,
    guest.id,
  )
  assert.equal(membership.n, 0, 'a removed member was made a member again')

  // Everyone else is untouched: the code they were read out still works.
  const someoneElse = await json(
    await call(B, '/shares/join', other.cookie, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  )
  assert.equal(someoneElse.status, 200, 'one removal locked the whole room out')
  await run('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', boardId, other.id)
})

test('a fresh code is the owner saying who may come back', async () => {
  await clearOwnAllowances()
  const boardId = await makeBoard('Let back in')

  const share = await json(
    await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }),
  )
  await json(
    await call(B, '/shares/join', guest.cookie, {
      method: 'POST',
      body: JSON.stringify({ code: share.body.share.code }),
    }),
  )
  await json(
    await call(A, `/boards/${boardId}/members/${guest.id}`, owner.cookie, { method: 'DELETE' }),
  )

  const refreshed = await json(
    await call(A, `/boards/${boardId}/share/code`, owner.cookie, { method: 'POST' }),
  )
  assert.equal(refreshed.status, 200)
  assert.notEqual(refreshed.body.share.code, share.body.share.code)

  const back = await json(
    await call(B, '/shares/join', guest.cookie, {
      method: 'POST',
      body: JSON.stringify({ code: refreshed.body.share.code }),
    }),
  )
  assert.equal(back.status, 200, 'the owner had no way to undo a removal')
})

test('no message the server originates can be sent by a client', async () => {
  const boardId = await makeBoard('Forged controls', [guest, other])
  // Anonymous, so that the one server-originated type whose damage is invisible
  // on the wire has somewhere to show. `anon` never reaches a browser either
  // way, so "no peer received it" says nothing at all about whether it was
  // relayed: what it does is rewrite the far instance's cache, and the only way
  // to see that from out here is to ask the room to name somebody afterwards.
  await call(A, `/boards/${boardId}/anonymous`, owner.cookie, {
    method: 'PATCH',
    body: JSON.stringify({ anonymous: true }),
  })

  // The forger is on B and both observers on A, so a forgery that was relayed
  // would have to cross the bus — which is the path that also runs it through
  // `applyControl` and rewrites the far instance's idea of the room.
  const targetSocket = await openSocket(A, boardId, owner.cookie)
  const memberSocket = await openSocket(A, boardId, other.cookie)
  const forger = await openSocket(B, boardId, guest.cookie)

  /**
   * Driven off the table rather than a list written here.
   *
   * The whole defect this file exists for was a type that somebody added to one
   * hand-maintained set and not the other, so a test naming them again would
   * have exactly the same hole and would pass through it.
   */
  const serverOnly = Object.entries(MESSAGE_TYPES)
    .filter(([, spec]) => spec.from === 'server')
    .map(([type]) => type)
  assert.ok(serverOnly.length >= 8, 'the catalogue lost its server-originated types')

  for (const type of serverOnly) {
    forger.send(
      JSON.stringify({
        type,
        // Every field any of them carries, all at once: the point is that the
        // type is refused before anything reads the rest.
        forged: true,
        locked: true,
        anonymous: false,
        userId: owner.id,
        sessionIds: [randomUUID()],
        peers: [],
      }),
    )
  }
  await sleep(CROSSED_MS)

  for (const socket of [targetSocket, memberSocket, forger]) {
    assert.equal(
      socket.received.some((m) => m.forged === true),
      false,
      'a server-originated message sent by a client was relayed to a browser',
    )
  }

  // Nobody was thrown out by the forged evictions.
  for (const socket of [targetSocket, memberSocket, forger]) {
    assert.equal(socket.closeInfo, null, 'a client evicted somebody')
  }

  // The forged anonymity flip did not take on the instance it crossed to.
  const named = await introduce(targetSocket, memberSocket)
  assert.match(named.displayName, ANONYMOUS_NAME, 'a client changed what the room discloses')

  // And neither did the forged lock: a member's ordinary op still reaches the
  // room on the instance the message would have crossed to.
  memberSocket.send(
    JSON.stringify({ type: 'patch', entity: 'token', id: 'f1', patch: { x: 1, y: 2 } }),
  )
  await waitForMessage(targetSocket, (m) => m.type === 'patch' && m.id === 'f1')

  await Promise.all([closed(targetSocket), closed(memberSocket), closed(forger)])
})

/**
 * The room closes at the moment of deletion, on the instance that was not told.
 *
 * The socket is on B and the delete goes to A, so this is the bus doing the
 * work rather than a local shortcut. Until the route published anything, the
 * only thing that ever closed this room was the reconciliation below, which
 * needs the far instance's listener to reopen: a member went on drawing on a
 * board whose row was gone, for as long as that took, while every REST call
 * they made answered 404.
 *
 * `waitForClose` is given a budget far under `RECONCILE_MS` on purpose. A
 * generous one would pass on the reconnect path and prove nothing about this
 * one.
 */
test('deleting a board closes its room at once, on every instance', async () => {
  const boardId = await makeBoard('Deleted underneath them', [guest])
  const memberSocket = await openSocket(B, boardId, guest.cookie)

  const deleted = await call(A, `/boards/${boardId}`, owner.cookie, { method: 'DELETE' })
  assert.equal(deleted.status, 204)

  assert.equal(await waitForClose(memberSocket, 5_000), 4404)
})

/**
 * A room does not outlive the row it was authorized against, even with nothing
 * to tell it.
 *
 * The immediate path above is the ordinary one now. This is the other half:
 * with the far instance deaf, the publish never arrives, and what closes the
 * room is the reconciliation an instance runs when its listener reopens, which
 * re-derives every open room from the rows instead of replaying events and
 * therefore does not care that it missed anything.
 *
 * The outage is the trigger here rather than the hazard, which is why the usual
 * "and the message was genuinely lost" negative is not asserted: the message
 * was lost, deliberately, and the reconnect is what has to notice.
 */
test('a board deleted while the bus was down closes its room on the way back', async () => {
  const boardId = await makeBoard('Deleted underneath', [guest])
  const memberSocket = await openSocket(B, boardId, guest.cookie)

  await dropBusOn(B)

  const deleted = await call(A, `/boards/${boardId}`, owner.cookie, { method: 'DELETE' })
  assert.equal(deleted.status, 204)

  // REST is already refusing it everywhere, which is the half that needed no
  // bus, while the socket carries on relaying a board that no longer exists.
  assert.equal((await call(B, `/boards/${boardId}`, guest.cookie)).status, 404)

  assert.ok(await busIsBackOn(B), 'the far instance never reconnected')
  assert.equal(await waitForClose(memberSocket, RECONCILE_MS), 4404)
})

test('one code cannot mint accounts without limit', async () => {
  await clearOwnAllowances()
  const boardId = await makeBoard('Guest flood')

  const share = await json(
    await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }),
  )
  assert.equal(share.status, 201)
  const { id: shareId, code } = share.body.share

  /**
   * Seeded near the limit rather than spent two hundred times over.
   *
   * What is being asserted is that a *success* charges the allowance at all,
   * which is the whole defect: the charge lived only on the failure paths, so
   * one valid six-character code minted accounts for as long as somebody held
   * the button down. How the counter behaves between one and its limit is
   * `rateLimit.test.js`'s subject and is not worth two hundred round trips here.
   * The key is asked of the module rather than spelled again, because a second
   * spelling is how a test ends up passing against a limiter writing elsewhere.
   *
   * Two short, not one, because `consume` refuses the attempt that *reaches* the
   * limit rather than the one after it. So this leaves exactly one join inside
   * the allowance and the next one outside it, which is what makes the pair of
   * assertions below say something: on its own, a 429 proves only that the
   * counter exists somewhere, not that it was the join that moved it.
   */
  const key = guestMintingKey(shareId)
  allowanceKeys.push(key)
  await run(
    'INSERT INTO login_attempts (key, count, locked_until, last_attempt) VALUES ($1, $2, 0, $3)',
    key,
    MAX_GUESTS_PER_SHARE - 2,
    Date.now(),
  )

  const asGuest = () =>
    call(B, '/shares/join', null, {
      method: 'POST',
      body: JSON.stringify({ code, asGuest: true }),
    })

  const last = await json(await asGuest())
  assert.equal(last.status, 200, 'a room inside the allowance was turned away')

  const overflow = await json(await asGuest())
  assert.equal(overflow.status, 429, 'one code minted accounts without limit')

  /**
   * And the room is not collateral damage.
   *
   * The allowance is on accounts being created, not on the code being redeemed,
   * so somebody who already has an account still joins while it is spent. That
   * separation is the reason this is a second allowance rather than a change to
   * the guessing one, which had to keep waving good codes through.
   */
  const signedIn = await json(
    await call(B, '/shares/join', other.cookie, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  )
  assert.equal(signedIn.status, 200, 'the guest cap turned away somebody who needed no account')
})

test('a client cannot forge a log line through a message type', () => {
  // The types this actually carries survive it unchanged, or the log stops
  // saying anything useful in exchange for the hardening.
  for (const type of Object.keys(MESSAGE_TYPES)) assert.equal(safeLabel(type), type)

  const forged = safeLabel('evict\nNot published: the notification bus is down')
  assert.equal(/[\r\n]/.test(forged), false, 'a client could start a log line of its own')
  assert.equal(forged.startsWith('evict.'), true, 'the forgery is still visible as one line')

  const long = safeLabel('x'.repeat(6000))
  assert.ok(long.length < 50, `an uncapped ${long.length} characters reached the log`)
})
