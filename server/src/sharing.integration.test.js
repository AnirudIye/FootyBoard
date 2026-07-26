import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, get, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'

/**
 * Sharing, end to end, across two API instances.
 *
 * Two rather than one on purpose. A single instance would pass even if the
 * LISTEN/NOTIFY fanout were broken, because every socket would be local — and
 * the cross-instance path is exactly where the interesting failures live: an op
 * that never leaves its process, or an editing lock that one instance has
 * cached and the other has not.
 *
 * The owner therefore connects to instance A and the collaborator to instance
 * B, so every assertion below travels through Postgres.
 */

const A = 8799
const B = 8800
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

const children = []
let owner
let collaborator
let stranger
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
  return { id, cookie: `${COOKIE_NAME}=${await createSession(id)}` }
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

/**
 * A socket that remembers everything it was sent.
 *
 * Resolves on `welcome` rather than on `open`, because the two are not the same
 * event: the handshake completes before the server has authorized anyone, so an
 * `open` socket may still be about to be closed with a 4403. `welcome` is the
 * server saying the room is actually yours.
 */
async function openSocket(port, board, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`, { headers: { Cookie: cookie } })
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
function waitForMessage(socket, match, timeoutMs = 3000) {
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

const seen = (socket, match) => socket.received.some(match)

before(async () => {
  await migrate()
  startInstance(A)
  startInstance(B)
  await Promise.all([waitForHealth(A), waitForHealth(B)])
  ;[owner, collaborator, stranger] = await Promise.all([makeUser(), makeUser(), makeUser()])

  const created = await json(
    await call(A, '/boards', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Shared board', data: { version: 1 } }),
    }),
  )
  assert.equal(created.status, 201)
  boardId = created.body.board.id
})

after(async () => {
  for (const child of children) child.kill()
  for (const user of [owner, collaborator, stranger]) {
    if (user) await run('DELETE FROM users WHERE id = $1', user.id)
  }
  await closePool()
})

test('a stranger cannot read the board, and it reads as missing rather than forbidden', async () => {
  const res = await json(await call(B, `/boards/${boardId}`, stranger.cookie))
  assert.equal(res.status, 404)
})

test('a stranger cannot open the room', async () => {
  await assert.rejects(
    () => openSocket(B, boardId, stranger.cookie),
    (err) => err.code === 4403,
  )
})

test('only the owner can create a share link', async () => {
  const refused = await json(
    await call(A, `/boards/${boardId}/share`, collaborator.cookie, { method: 'POST' }),
  )
  assert.equal(refused.status, 404, 'a non-member is not told the board exists')
})

test('redeeming a link grants membership and read access on any instance', async () => {
  const created = await json(await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }))
  assert.equal(created.status, 201)
  const token = created.body.share.token
  assert.ok(token, 'the plaintext token is returned exactly once')

  // Redeemed against the *other* instance, to prove nothing is held in memory.
  const redeemed = await json(await call(B, `/shares/${token}/redeem`, collaborator.cookie, { method: 'POST' }))
  assert.equal(redeemed.status, 200)
  assert.equal(redeemed.body.board.id, boardId)

  const read = await json(await call(B, `/boards/${boardId}`, collaborator.cookie))
  assert.equal(read.status, 200)
  assert.equal(read.body.board.role, 'member')

  // Redeeming twice is harmless rather than an error.
  const again = await json(await call(B, `/shares/${token}/redeem`, collaborator.cookie, { method: 'POST' }))
  assert.equal(again.status, 200)
  const count = await get(
    'SELECT count(*)::int AS n FROM board_members WHERE board_id = $1 AND user_id = $2',
    boardId,
    collaborator.id,
  )
  assert.equal(count.n, 1)
})

test('the share link never comes back after it is issued', async () => {
  const meta = await json(await call(A, `/boards/${boardId}/share`, owner.cookie))
  assert.equal(meta.status, 200)
  assert.ok(meta.body.share, 'the owner can see that a link is live')
  assert.equal(meta.body.share.token, undefined, 'but not what it is')
})

test('the board list includes boards shared with you, marked as such', async () => {
  const list = await json(await call(B, '/boards?limit=50', collaborator.cookie))
  assert.equal(list.status, 200)
  const entry = list.body.boards.find((b) => b.id === boardId)
  assert.ok(entry, 'a shared board appears in the list')
  assert.equal(entry.role, 'member')

  const ownerList = await json(await call(A, '/boards?limit=50', owner.cookie))
  const ownEntry = ownerList.body.boards.find((b) => b.id === boardId)
  assert.equal(ownEntry.role, 'owner')
  assert.equal(
    ownerList.body.boards.filter((b) => b.id === boardId).length,
    1,
    'the union does not duplicate a board you own',
  )
})

test('an op crosses from one instance to another', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  const welcome = await waitForMessage(b, (m) => m.type === 'welcome')
  assert.equal(welcome.role, 'member')
  assert.equal(welcome.locked, false, 'boards default to unlocked')

  a.send(JSON.stringify({ type: 'patch', entity: 'token', id: 't1', patch: { x: 40, y: 60 } }))

  const relayed = await waitForMessage(b, (m) => m.type === 'patch')
  assert.deepEqual(relayed.patch, { x: 40, y: 60 })
  assert.ok(relayed.peerId, 'the sender is stamped by the server')
  assert.notEqual(relayed.peerId, welcome.peerId, 'and it is not the receiver')

  a.close()
  b.close()
})

test('an op sent the instant the socket opens is not lost', async () => {
  // The handshake completes before the server has finished authorizing, so
  // anything sent on `open` arrives mid-await. It has to be queued and drained
  // rather than dropped, or a client's first op after connecting disappears
  // whenever the database is a little slow.
  const listener = await openSocket(A, boardId, owner.cookie)

  const eager = new WebSocket(`ws://127.0.0.1:${B}/ws?board=${boardId}`, {
    headers: { Cookie: collaborator.cookie },
  })
  eager.on('open', () => {
    eager.send(JSON.stringify({ type: 'patch', entity: 'token', id: 'eager', patch: { x: 7, y: 7 } }))
  })

  const relayed = await waitForMessage(listener, (m) => m.type === 'patch' && m.id === 'eager')
  assert.deepEqual(relayed.patch, { x: 7, y: 7 })

  eager.close()
  listener.close()
})

test('peers on different instances discover each other', async () => {
  // `welcome` can only list sockets on the instance that answered, and the
  // cluster spreads a room across all of them — so without the introduction
  // exchange a joiner sees only the subset that happened to share its process.
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  // A learns of B's arrival directly.
  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.email, `${collaborator.id}@test.invalid`)

  // B, which saw an empty roster, learns of A only because A answers.
  a.send(JSON.stringify({ type: 'here' }))
  const present = await waitForMessage(b, (m) => m.type === 'peer-present')
  assert.equal(present.email, `${owner.id}@test.invalid`)
  assert.ok(present.peerId, 'identity is stamped by the server, not taken from the message')

  a.close()
  b.close()
})

test('an introduction cannot be forged, and does not echo back to its sender', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  // The email is ignored: the server stamps the socket's own.
  b.send(JSON.stringify({ type: 'here', email: 'someone@else.example' }))
  const present = await waitForMessage(a, (m) => m.type === 'peer-present')
  assert.equal(present.email, `${collaborator.id}@test.invalid`)

  // And it does not come back to B, which would make B answer its own
  // introduction and never stop.
  b.send(JSON.stringify({ type: 'cursor', x: 1, y: 1 }))
  await waitForMessage(a, (m) => m.type === 'cursor')
  assert.equal(seen(b, (m) => m.type === 'peer-present'), false)

  a.close()
  b.close()
})

test('a client cannot forge a peer-present message', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  b.send(JSON.stringify({ type: 'peer-present', peerId: 'ghost', email: 'ghost@example.com' }))
  b.send(JSON.stringify({ type: 'cursor', x: 4, y: 4 }))

  await waitForMessage(a, (m) => m.type === 'cursor' && m.x === 4)
  assert.equal(
    seen(a, (m) => m.type === 'peer-present' && m.peerId === 'ghost'),
    false,
    'presence is the server’s to report, so a client cannot invent a peer',
  )

  a.close()
  b.close()
})

test('a client cannot forge a lock message', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  // Send the forbidden message, then a permitted one. When the second arrives
  // the first has had its chance, which makes this a real assertion rather
  // than a race against a timeout.
  b.send(JSON.stringify({ type: 'lock', locked: true }))
  b.send(JSON.stringify({ type: 'cursor', x: 1, y: 2 }))

  await waitForMessage(a, (m) => m.type === 'cursor')
  assert.equal(seen(a, (m) => m.type === 'lock'), false)

  a.close()
  b.close()
})

test('locking the board stops a member editing, on the instance they are not on', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  const locked = await json(
    await call(A, `/boards/${boardId}/lock`, owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ locked: true }),
    }),
  )
  assert.equal(locked.status, 200)

  // The lock reaches the collaborator's socket even though it was set on the
  // other instance.
  const announced = await waitForMessage(b, (m) => m.type === 'lock')
  assert.equal(announced.locked, true)

  b.send(JSON.stringify({ type: 'patch', entity: 'token', id: 't2', patch: { x: 1, y: 1 } }))
  b.send(JSON.stringify({ type: 'cursor', x: 9, y: 9 }))

  await waitForMessage(a, (m) => m.type === 'cursor' && m.x === 9)
  assert.equal(
    seen(a, (m) => m.type === 'patch' && m.id === 't2'),
    false,
    'the edit was dropped by the relay, while presence still flows',
  )

  // And the same lock blocks the REST path, so it cannot be routed around.
  const save = await json(
    await call(B, `/boards/${boardId}`, collaborator.cookie, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Shared board', data: { version: 1, sneaky: true } }),
    }),
  )
  assert.equal(save.status, 403)

  // The owner is never locked out by their own lock.
  const ownerSave = await json(
    await call(A, `/boards/${boardId}`, owner.cookie, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Shared board', data: { version: 1 } }),
    }),
  )
  assert.equal(ownerSave.status, 200)

  a.close()
  b.close()
})

test('unlocking lets the member edit again', async () => {
  const a = await openSocket(A, boardId, owner.cookie)
  const b = await openSocket(B, boardId, collaborator.cookie)

  await call(A, `/boards/${boardId}/lock`, owner.cookie, {
    method: 'PATCH',
    body: JSON.stringify({ locked: false }),
  })
  await waitForMessage(b, (m) => m.type === 'lock' && m.locked === false)

  b.send(JSON.stringify({ type: 'patch', entity: 'token', id: 't3', patch: { x: 2, y: 2 } }))
  await waitForMessage(a, (m) => m.type === 'patch' && m.id === 't3')

  a.close()
  b.close()
})

test('revoking the link stops new joins but keeps existing members', async () => {
  const created = await json(await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }))
  const token = created.body.share.token

  const revoked = await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'DELETE' })
  assert.equal(revoked.status, 204)

  const attempt = await json(await call(B, `/shares/${token}/redeem`, stranger.cookie, { method: 'POST' }))
  assert.equal(attempt.status, 404)
  assert.equal(attempt.body.error, 'That link is not valid any more.')

  const stillIn = await json(await call(B, `/boards/${boardId}`, collaborator.cookie))
  assert.equal(stillIn.status, 200, 'revoking a link does not eject the people who used it')
})

test('rotating the link invalidates the previous one', async () => {
  const first = await json(await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }))
  const second = await json(await call(A, `/boards/${boardId}/share`, owner.cookie, { method: 'POST' }))
  assert.notEqual(first.body.share.token, second.body.share.token)

  const old = await call(B, `/shares/${first.body.share.token}/redeem`, stranger.cookie, { method: 'POST' })
  assert.equal(old.status, 404)

  const current = await call(B, `/shares/${second.body.share.token}/redeem`, stranger.cookie, { method: 'POST' })
  assert.equal(current.status, 200)

  await run('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', boardId, stranger.id)
})

test('removing a member closes their socket on whichever instance holds it', async () => {
  const b = await openSocket(B, boardId, collaborator.cookie)

  const removed = await call(A, `/boards/${boardId}/members/${collaborator.id}`, owner.cookie, {
    method: 'DELETE',
  })
  assert.equal(removed.status, 204)

  await new Promise((resolve) => b.once('close', resolve))
  assert.equal(b.closeInfo.code, 4403)

  const after = await json(await call(B, `/boards/${boardId}`, collaborator.cookie))
  assert.equal(after.status, 404, 'and their access is gone')
})
