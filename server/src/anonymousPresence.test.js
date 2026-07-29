import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * Anonymous presence, across two API instances.
 *
 * The claim being tested is narrow and worth stating exactly: with the setting
 * on, **no address is on the wire at all**. Not hidden by the interface, not
 * filtered on arrival — never sent. So the central assertion is deliberately
 * blunt rather than clever: take everything both sockets were ever handed, turn
 * it back into text, and look for an `@`. A substitution that happened anywhere
 * other than in the server's own payload builder fails that.
 *
 * Two instances for the same reason the sharing suite uses two: the owner and
 * the guest land on different processes, so every introduction here travels
 * through Postgres LISTEN/NOTIFY rather than passing locally inside one.
 *
 * Its own ports, because `node --test` runs files concurrently and :8799 to
 * :8801 are already spoken for by the other integration suites.
 */

const A = 8802
const B = 8803
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

const children = []
let owner
let guest
let other
let boardId

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

/** Resolves on `welcome`, which is the server saying the room is actually yours. */
async function openSocket(port, board, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`, { headers: { Cookie: cookie } })
  socket.received = []

  socket.on('message', (raw) => socket.received.push(JSON.parse(raw)))

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

const closed = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve()
    socket.once('close', resolve)
    socket.close()
  })

const setAnonymous = (anonymous, cookie = owner.cookie, port = A) =>
  call(port, `/boards/${boardId}/anonymous`, cookie, {
    method: 'PATCH',
    body: JSON.stringify({ anonymous }),
  })

/**
 * The room's cached copy of the setting lives for as long as the room does, so
 * a test that changes it while sockets are open is testing the broadcast path
 * rather than the read path. Both matter, and they are tested separately, so
 * most tests here start from an empty room and let the next socket read the row.
 */
const ANONYMOUS_NAME = /^Anonymous [A-Z][a-z]+$/

before(async () => {
  await migrate()
  startInstance(A)
  startInstance(B)
  await Promise.all([waitForHealth(A), waitForHealth(B)])
  ;[owner, guest, other] = await Promise.all([makeUser(), makeUser(), makeUser()])

  const created = await json(
    await call(A, '/boards', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Session', data: testBoard() }),
    }),
  )
  assert.equal(created.status, 201)
  boardId = created.body.board.id

  // Admitted directly rather than through a share link: this suite is about
  // what the room says, not about how people got into it, and redeeming spends
  // a per-IP allowance that has nothing to do with any of it.
  for (const member of [guest, other]) {
    await run(
      `INSERT INTO board_members (board_id, user_id, joined_at) VALUES ($1, $2, $3)
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      boardId,
      member.id,
      new Date().toISOString(),
    )
  }
})

after(async () => {
  for (const child of children) child.kill()
  for (const user of [owner, guest, other]) {
    if (user) await run('DELETE FROM users WHERE id = $1', user.id)
  }
  await closePool()
})

test('a board starts out naming people by their address', async () => {
  const state = await json(await call(A, `/boards/${boardId}/share`, owner.cookie))
  assert.equal(state.status, 200)
  assert.equal(state.body.anonymousPresence, false, 'off by default')

  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, guest.cookie)

  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.email, guest.email)
  assert.equal(joined.displayName, guest.email, 'the display name is the address when nothing is hidden')

  await Promise.all([closed(a), closed(b)])
})

test('with anonymous guests on, no presence payload carries an address', async () => {
  const set = await json(await setAnonymous(true))
  assert.equal(set.status, 200)
  assert.equal(set.body.anonymousPresence, true)

  // Three sockets, spread across both instances, so that every path that names
  // somebody is exercised: the `welcome` roster (same instance), `peer-joined`
  // (any instance) and the `here` / `peer-present` introduction exchange.
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, guest.cookie)

  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.match(joined.displayName, ANONYMOUS_NAME)
  assert.match(joined.email, ANONYMOUS_NAME, 'the disclosed field is the generated name, not an address')

  // The guest's own roster was empty, so they learn of the owner only because
  // the owner answers. That answer is built from the same substitution.
  a.send(JSON.stringify({ type: 'here' }))
  const present = await waitForMessage(b, (m) => m.type === 'peer-present')
  assert.match(present.displayName, ANONYMOUS_NAME)

  // A third socket on the owner's instance gets a populated `welcome` roster,
  // which is the one payload the two assertions above cannot reach.
  const c = await openSocket(A, boardId, other.cookie)
  const welcome = c.received.find((m) => m.type === 'welcome')
  assert.ok(welcome.peers.length >= 1, 'the roster lists the sockets on this instance')
  for (const peer of welcome.peers) {
    assert.match(peer.displayName, ANONYMOUS_NAME)
  }

  /**
   * The blunt one, and the actual point.
   *
   * Everything all three sockets were ever handed, as text. An `@` anywhere in
   * it means an address travelled, whatever the interface would have done with
   * it afterwards.
   */
  for (const socket of [a, b, c]) {
    assert.equal(
      JSON.stringify(socket.received).includes('@'),
      false,
      'an address reached a client',
    )
  }

  await Promise.all([closed(a), closed(b), closed(c)])
})

test('the same person keeps the same name across a reconnect', async () => {
  const a = await openSocket(A, boardId, owner.cookie)

  const first = await openSocket(B, boardId, guest.cookie)
  const before = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.match(before.displayName, ANONYMOUS_NAME)
  await closed(first)

  // Wait for the room to actually let them go, so the reconnect is a fresh
  // arrival rather than a second socket sitting alongside the first.
  await waitForMessage(a, (m) => m.type === 'peer-left' && m.peerId === before.peerId)

  const second = await openSocket(B, boardId, guest.cookie)
  const after = await waitForMessage(
    a,
    (m) => m.type === 'peer-joined' && m.peerId !== before.peerId,
  )

  assert.equal(
    after.displayName,
    before.displayName,
    'the name is derived from who they are and which board this is, so it survives a reconnect',
  )
  assert.notEqual(after.peerId, before.peerId, 'while the socket really is a new one')

  await Promise.all([closed(a), closed(second)])
})

test('two different people in one room get different names', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, guest.cookie)
  const c = await openSocket(B, boardId, other.cookie)

  const names = new Set()
  for (const socket of [b, c]) {
    const joined = await waitForMessage(a, (m) => m.type === 'peer-joined' && m.peerId === (
      socket.received.find((x) => x.type === 'welcome').peerId
    ))
    names.add(joined.displayName)
  }
  assert.equal(names.size, 2, 'a collision is probed past rather than shared')

  await Promise.all([closed(a), closed(b), closed(c)])
})

test('the owner still sees real addresses in the members list', async () => {
  // The whole point of doing this in the payload rather than in the interface
  // is that the two questions stay separate: "who has access to my board" is
  // the owner's to know, over REST; "who is that cursor" is not the room's.
  const list = await json(await call(A, `/boards/${boardId}/members`, owner.cookie))
  assert.equal(list.status, 200)
  assert.ok(
    list.body.members.some((m) => m.email === guest.email),
    'the owner-scoped members endpoint is unaffected',
  )
})

test('turning it back off restores addresses', async () => {
  const set = await json(await setAnonymous(false))
  assert.equal(set.status, 200)

  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, guest.cookie)

  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.email, guest.email)
  assert.equal(joined.displayName, guest.email)

  await Promise.all([closed(a), closed(b)])
})

test('the setting reaches an instance holding a room it was not set on', async () => {
  // The room is open on A and the change is made on B, so the only way A can
  // know is the NOTIFY bus. Without it A would keep serving names out of a
  // cache that is now wrong.
  const a = await openSocket(A, boardId, owner.cookie)

  const set = await json(await setAnonymous(true, owner.cookie, B))
  assert.equal(set.status, 200)

  /**
   * The effect is polled rather than the cache, because the cache is not
   * reachable from out here and the effect is what matters anyway: a peer
   * joining is named by whichever instance holds the room, so a name in the new
   * style is proof that A applied the broadcast. Retried because the write
   * returns as soon as the NOTIFY is sent, which is a moment before A has read
   * it.
   */
  let joined = null
  for (let attempt = 0; attempt < 10 && joined === null; attempt++) {
    const seen = new Set(
      a.received.filter((m) => m.type === 'peer-joined').map((m) => m.peerId),
    )
    const b = await openSocket(B, boardId, guest.cookie)
    const message = await waitForMessage(
      a,
      (m) => m.type === 'peer-joined' && !seen.has(m.peerId),
    )
    if (ANONYMOUS_NAME.test(message.displayName)) joined = message
    await closed(b)
    if (joined === null) await new Promise((r) => setTimeout(r, 150))
  }

  assert.ok(joined, 'the instance holding the room never heard about the change')

  await closed(a)
  await setAnonymous(false)
})

test('neither owner-only switch can be thrown by a member', async () => {
  const anonymity = await json(
    await call(B, `/boards/${boardId}/anonymous`, guest.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ anonymous: true }),
    }),
  )
  assert.equal(anonymity.status, 403, 'a member is on the board, so it exists — they just may not do this')

  const instructor = await json(
    await call(B, `/boards/${boardId}/lock`, guest.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ locked: true }),
    }),
  )
  assert.equal(instructor.status, 403)

  // And neither of them actually changed anything.
  const state = await json(await call(A, `/boards/${boardId}/share`, owner.cookie))
  assert.equal(state.body.anonymousPresence, false)
})

test('a stranger is not even told the board exists', async () => {
  const stranger = await makeUser()
  try {
    const res = await json(
      await call(B, `/boards/${boardId}/anonymous`, stranger.cookie, {
        method: 'PATCH',
        body: JSON.stringify({ anonymous: true }),
      }),
    )
    assert.equal(res.status, 404)
  } finally {
    await run('DELETE FROM users WHERE id = $1', stranger.id)
  }
})

test('the switch needs to say which way it is going', async () => {
  const res = await json(
    await call(A, `/boards/${boardId}/anonymous`, owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ anonymous: 'yes' }),
    }),
  )
  assert.equal(res.status, 400)
})
