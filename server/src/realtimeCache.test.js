import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, get, pool, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * The relay's two per-room caches, and the window they are seeded in.
 *
 * `membersCanEdit` and `anonymousPresence` are each read from the database once
 * per room and thereafter corrected only by the NOTIFY bus, which `applyControl`
 * refuses to record for a board this instance holds no room for. That refusal is
 * sound only if the read that seeds a cache happens *after* the room exists, and
 * only for a socket that really joined. Two bugs came out of it being neither:
 *
 * - an entry written before the "has this socket already gone?" check outlived
 *   every socket that could have removed it, so an instance served an anonymous
 *   board's real addresses for the life of the process;
 * - a value read before `room.add` was seeded on top of a lock the owner threw
 *   in the meantime, so members were told the board was unlocked, their edits
 *   were relayed to the whole room, and `PUT` then refused to save any of them.
 *
 * Neither is reachable by connecting and disconnecting quickly and hoping. Every
 * test below holds the server still at an exact point using Postgres locks, so
 * the interleaving is something the database enforces rather than something the
 * test races for. Three properties do the work:
 *
 * - `LOCK TABLE board_members IN ACCESS EXCLUSIVE MODE` parks `accessFor`, which
 *   joins the two tables, *after* it has taken its share lock on `boards`.
 * - a lock request that conflicts with a holder queues, and later requests queue
 *   behind the waiter. So an exclusive request on `boards` made at that moment
 *   parks every subsequent read of `boards` without disturbing the statement
 *   already holding its share lock.
 * - `SELECT ... FOR UPDATE` on the board row parks the lock route's `UPDATE`
 *   after its owner check has passed, so the write can be released into a
 *   window rather than raced into one.
 *
 * Two instances, like the other realtime suites, so the control message travels
 * through LISTEN/NOTIFY rather than passing locally inside one process.
 */

const A = 8805
const B = 8806
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/** Long enough that a parked query is genuinely parked on a loaded machine. */
const SETTLE_MS = 400

const children = []
let owner
let guest

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

async function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`instance on :${port} never became healthy`)
}

/** A signed-in user, without going through the IP-rate-limited signup route. */
async function makeUser() {
  const id = randomUUID()
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, 'x', 'x', $3, $3)`,
    id,
    `${id}@test.invalid`,
    new Date().toISOString(),
  )
  return { id, email: `${id}@test.invalid`, cookie: `${COOKIE_NAME}=${await createSession(id)}` }
}

const call = (port, path, cookie, init = {}) =>
  fetch(`http://127.0.0.1:${port}/api${path}`, {
    ...init,
    headers: {
      Cookie: cookie,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** A fresh board with `guest` on it, so no instance has ever opened a room for it. */
async function makeBoard(name) {
  const created = await json(
    await call(A, '/boards', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ name, data: testBoard() }),
    }),
  )
  assert.equal(created.status, 201)
  const id = created.body.board.id
  await run(
    `INSERT INTO board_members (board_id, user_id, joined_at) VALUES ($1, $2, $3)
     ON CONFLICT (board_id, user_id) DO NOTHING`,
    id,
    guest.id,
    new Date().toISOString(),
  )
  return id
}

/**
 * A socket that is only waited on when the test says so.
 *
 * The other suites resolve on `welcome`, which is no use here: every socket
 * below is deliberately held somewhere in the middle of authorization, and two
 * of them never get a `welcome` at all.
 */
function connect(port, board, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`, { headers: { Cookie: cookie } })
  socket.received = []
  socket.on('message', (raw) => socket.received.push(JSON.parse(raw)))
  socket.on('error', () => {})
  socket.opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('close', () => reject(new Error('closed before it opened')))
  })
  // Handled here as well as wherever it is awaited. A socket still connecting
  // when an assertion fails is closed by the `finally`, and an unhandled
  // rejection from that would be reported in place of the assertion that
  // actually failed.
  socket.opened.catch(() => {})
  return socket
}

/** Resolves with the first message matching `match`, or throws on timeout. */
function waitForMessage(socket, match, timeoutMs = 6000) {
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

const closed = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve()
    socket.once('close', resolve)
    socket.close()
  })

/** Gone at the transport level, which is what a client dying mid-handshake is. */
const terminated = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve()
    socket.once('close', resolve)
    socket.terminate()
  })

/**
 * A dedicated connection holding one lock, released by being destroyed.
 *
 * Destroyed rather than committed, because two of these are asked for a lock
 * that is deliberately not granted yet: the pending statement would sit in front
 * of any `ROLLBACK` sent after it, so a test that failed early would leave the
 * table locked for every other suite in the run. Ending the connection aborts
 * the transaction whatever state it is in.
 *
 * The lock is requested without being waited on, because for two of the three
 * the whole point is that it is still queued.
 */
async function holder(sql, ...params) {
  const client = await pool.connect()
  let released = false
  await client.query('BEGIN')
  const granted = client.query(sql, params).catch(() => {})
  return {
    /** Only wait on this where the lock is certain to be granted immediately. */
    ready: () => granted,
    release: () => {
      if (released) return
      released = true
      client.release(true)
    },
  }
}

const ANONYMOUS_NAME = /^Anonymous [A-Z][a-z]+$/

/** Everything these sockets were handed, as text. An `@` means an address travelled. */
function assertNoAddressReached(sockets) {
  for (const socket of sockets) {
    assert.equal(
      JSON.stringify(socket.received).includes('@'),
      false,
      'an address reached a client on a board whose owner asked for anonymity',
    )
  }
}

/**
 * The owner turns anonymity on from the instance that is *not* under test, so
 * the only way the instance under test can learn of it is the bus.
 */
async function turnAnonymityOn(boardId) {
  const set = await json(
    await call(B, `/boards/${boardId}/anonymous`, owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ anonymous: true }),
    }),
  )
  assert.equal(set.status, 200)
  assert.equal(set.body.anonymousPresence, true)
  await wait(SETTLE_MS)
}

/**
 * Two real guests on the instance that saw the socket die. Nothing they are
 * handed may contain an address.
 */
async function assertRoomIsAnonymous(boardId, why) {
  const a = connect(A, boardId, owner.cookie)
  const b = connect(A, boardId, guest.cookie)
  try {
    await waitForMessage(a, (m) => m.type === 'welcome')
    const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
    assert.match(joined.displayName, ANONYMOUS_NAME, why)
    assert.match(joined.email, ANONYMOUS_NAME, why)
    assertNoAddressReached([a, b])
  } finally {
    await Promise.all([closed(a), closed(b)])
  }
}

before(async () => {
  await migrate()
  startInstance(A)
  startInstance(B)
  await Promise.all([waitForHealth(A), waitForHealth(B)])
  ;[owner, guest] = await Promise.all([makeUser(), makeUser()])
})

after(async () => {
  for (const child of children) child.kill()
  for (const user of [owner, guest]) {
    if (user) await run('DELETE FROM users WHERE id = $1', user.id)
  }
  await closePool()
})

/**
 * Finding #2: nothing is cached for a socket that never joined a room.
 *
 * React's `StrictMode` double-mounts the hook that opens the socket, so in
 * development every board connects and immediately disconnects once, and a
 * flaky connection does the same in production. Here the disconnect is made
 * certain rather than likely: `accessFor` is parked on a table lock, so the
 * socket is provably still being authorized when the client goes away.
 *
 * The instance was then left holding "this board names people normally" for a
 * board it has no room for, and nothing could correct it: `applyControl`
 * refuses to record the owner's change with no room to apply it to, and the
 * next socket to arrive skips the read because the cache claims to know.
 */
test('a socket that dies while it is being authorized caches nothing', async () => {
  const boardId = await makeBoard('Orphan during authorization')
  const boards = await holder('LOCK TABLE boards IN ACCESS EXCLUSIVE MODE')

  try {
    await boards.ready()

    // Parked inside authorization: `accessFor` reads `boards`, which is locked.
    const dying = connect(A, boardId, guest.cookie)
    await dying.opened
    await wait(SETTLE_MS)
    await terminated(dying)
    await wait(SETTLE_MS)
  } finally {
    boards.release()
  }

  // Whatever that socket was going to make the instance do, it has now done.
  await wait(SETTLE_MS * 2)

  await turnAnonymityOn(boardId)
  await assertRoomIsAnonymous(
    boardId,
    'the instance answered out of a cache the socket that died left behind',
  )
})

/**
 * Finding #2 again, in the window that fixing it opens.
 *
 * The read that seeds both caches now happens after `room.add`, which is what
 * makes it correct, and which means the socket can die *during* it - with a
 * `close` handler that this time really does take it out of the room and drop
 * the room's cached flags. Writing them after that would put the orphan
 * straight back, one step further along.
 *
 * The socket is held at exactly that point: parked in `accessFor` until an
 * exclusive request on `boards` has queued behind the share lock it is holding,
 * so that the read it issues immediately after joining is the query that blocks.
 */
test('a socket that dies while the room is being read caches nothing either', async () => {
  const boardId = await makeBoard('Orphan during the seeding read')

  const members = await holder('LOCK TABLE board_members IN ACCESS EXCLUSIVE MODE')
  let boards = null

  try {
    await members.ready()

    // `accessFor` takes its share lock on `boards` first, then parks on the
    // join to `board_members`.
    const dying = connect(A, boardId, guest.cookie)
    await dying.opened
    await wait(SETTLE_MS)

    // Queued behind the share lock the parked socket already holds, so it
    // cannot park the statement that is about to release it.
    boards = await holder('LOCK TABLE boards IN ACCESS EXCLUSIVE MODE')
    await wait(SETTLE_MS)

    // Authorization finishes, the socket joins the room, and its read of the
    // room's flags is the next thing to ask for `boards` - which is now spoken
    // for by the request queued above.
    members.release()
    await wait(SETTLE_MS * 2)

    await terminated(dying)
    await wait(SETTLE_MS)
  } finally {
    members.release()
    boards?.release()
  }

  await wait(SETTLE_MS * 2)

  await turnAnonymityOn(boardId)
  await assertRoomIsAnonymous(
    boardId,
    'the read that seeds a room put back a cache entry for a socket that had gone',
  )
})

/**
 * Finding #6: a lock thrown while a socket is joining is not undone by it.
 *
 * The choreography puts the owner's `PATCH .../lock` strictly between the
 * joining socket's authorization and the moment it can seed the room, which is
 * the window the bug lived in:
 *
 * 1. the board row is held, so the route's `UPDATE` parks *after* its owner
 *    check has passed, with nothing left to do but commit and publish;
 * 2. `board_members` is held, so the socket's `accessFor` parks having taken
 *    its share lock on `boards` and before it can read `members_can_edit`;
 * 3. an exclusive lock on `boards` is requested, which queues behind that share
 *    lock and thereafter parks every later read of the table;
 * 4. `board_members` is released, so `accessFor` completes - reading the board
 *    as unlocked, because it still is - and the next thing the socket asks
 *    `boards` for is parked by (3);
 * 5. the board row is released, so the lock commits and publishes into an
 *    instance holding no room for the board, where `applyControl` drops it;
 * 6. `boards` is released and the socket finishes joining.
 *
 * Postgres does the sequencing at 5 and 6, not the sleeps: the exclusive
 * request from (3) cannot be granted until the route's `UPDATE` commits, and
 * the socket's read is queued behind that request, so the socket physically
 * cannot finish joining until the lock has been written and broadcast.
 */
test('a lock thrown while a socket is joining is not undone by the socket', async () => {
  const boardId = await makeBoard('Lock during the join window')

  const row = await holder('SELECT id FROM boards WHERE id = $1 FOR UPDATE', boardId)
  let members = null
  let boards = null
  let locking = null
  let joining = null

  try {
    await row.ready()

    // The owner check passes; the `UPDATE` parks on the row lock.
    locking = call(B, `/boards/${boardId}/lock`, owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ locked: true }),
    })
    await wait(SETTLE_MS)

    members = await holder('LOCK TABLE board_members IN ACCESS EXCLUSIVE MODE')
    await members.ready()

    joining = connect(A, boardId, guest.cookie)
    await joining.opened
    await wait(SETTLE_MS)

    boards = await holder('LOCK TABLE boards IN ACCESS EXCLUSIVE MODE')
    await wait(SETTLE_MS)

    members.release()
    await wait(SETTLE_MS * 2)

    // The lock is written and published into an instance with no room for it.
    row.release()
    const locked = await json(await locking)
    locking = null
    assert.equal(locked.status, 200)
    assert.equal(locked.body.locked, true)
    await wait(SETTLE_MS * 2)
  } finally {
    row.release()
    members?.release()
    boards?.release()
    if (locking) await locking.catch(() => {})
  }

  // Only now that `boards` is readable again. Reading it inside the block above
  // would have this test wait on its own exclusive lock.
  const stored = await get('SELECT members_can_edit FROM boards WHERE id = $1', boardId)
  assert.equal(stored.members_can_edit, false, 'the database has the board locked')

  // Connected before anything is asserted, so that a failing assertion closes a
  // socket that is up rather than one still mid-handshake.
  const owning = connect(B, boardId, owner.cookie)
  try {
    await waitForMessage(owning, (m) => m.type === 'welcome')

    const welcome = await waitForMessage(joining, (m) => m.type === 'welcome')
    assert.equal(
      welcome.locked,
      true,
      'the joining socket was told the board is unlocked, so its interface offers an edit the server will refuse',
    )

    /**
     * And the relay agrees, which is the half that actually costs work.
     *
     * A cached lock that is wrong does not merely mislabel an interface: the op
     * passes the relay's check, reaches every peer in the room on every
     * instance, and is then refused by `PUT`, so the room shows edits that
     * vanish on reload. The cursor is a sentinel - it is allowed while locked,
     * it is sent second, and both travel the same bus in order, so its arrival
     * is proof the op was not merely slower.
     */
    joining.send(JSON.stringify({ type: 'move', id: 'p1', x: 0.5, y: 0.5 }))
    joining.send(JSON.stringify({ type: 'cursor', x: 0.1, y: 0.1 }))

    await waitForMessage(owning, (m) => m.type === 'cursor')
    assert.equal(
      owning.received.some((m) => m.type === 'move'),
      false,
      'an edit from a locked-out member was relayed to the room',
    )
  } finally {
    await Promise.all([closed(joining), closed(owning)])
  }
})
