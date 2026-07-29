import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * What the write path will accept as a board.
 *
 * `validateBoardData` used to check two things: that the field was present, and
 * that it serialised to under half a megabyte. Anything else went in. So
 * `POST /api/boards` with a body of `{"v":1}` answered 201, wrote it, encrypted
 * it, and handed back an id. The client then refused to open the row,
 * because `isPersistedBoard` is a real check and it runs on read. Eight of the
 * seventeen rows in the dev database are that, and the "That board could not be
 * opened" path exists to cope with them.
 *
 * The gap was never that the client's guard was too strict. It was that the two
 * ends were asking the same question and only one of them was asking it, so the
 * server kept accepting rows the client would refuse. They share one function
 * now (`src/lib/boardSchema.js`), which is what these tests are really pinning:
 * the payloads below are the shapes the dev database actually collected.
 *
 * Both endpoints are covered, because a gap on `PUT` is the same gap, and it is
 * the worse one, since `PUT` overwrites a board that was fine a moment ago.
 */

const PORT = 8809
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
let user

/** The exact shapes the unloadable rows in the dev database carry. */
const JUNK = [
  { v: 1 },
  { version: 1 },
  { version: 2 },
  { version: 2, tokens: [] },
  // A whole board with one array taken out, which is what a truncated write
  // looks like and is the case a version check on its own would wave through.
  testBoard({ frames: undefined }),
  testBoard({ view: null }),
  'a string',
  42,
  [],
]

/** Enough of a payload to name it in a failure, without printing a whole board. */
const label = (data) => JSON.stringify(data)?.slice(0, 60) ?? String(data)

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

const call = (path, init) =>
  fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: { Cookie: user.cookie, 'Content-Type': 'application/json' },
  })

const post = (body) => call('/boards', { method: 'POST', body: JSON.stringify(body) })
const put = (id, body) => call(`/boards/${id}`, { method: 'PUT', body: JSON.stringify(body) })

/**
 * Status and body together, read once.
 *
 * A `Response` body can only be consumed once, and an assertion message is
 * evaluated whether or not it is needed, so `assert.equal(res.status, 201,
 * await res.text())` quietly makes the body unavailable to the rest of the test.
 */
const read = async (res) => {
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null }
}

before(async () => {
  await migrate()

  const id = randomUUID()
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, 'x', 'x', $3, $3)`,
    id,
    `${id}@test.invalid`,
    new Date().toISOString(),
  )
  user = { id, cookie: `${COOKIE_NAME}=${await createSession(id)}` }

  // Nothing here goes near a rate limiter: the session is minted directly
  // rather than by signing in, and the board endpoints are not limited. There
  // are therefore no `login_attempts` rows of ours to clear.
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
  // Takes this account's boards with it, so the suite adds nothing to the pile
  // of rows this whole defect was about.
  await run('DELETE FROM boards WHERE user_id = $1', user.id)
  await run('DELETE FROM users WHERE id = $1', user.id)
  await closePool()
})

test('a real board payload is still accepted, on both endpoints', async () => {
  // First, because everything below is only worth having if this holds. A guard
  // stricter than the client's own serialiser would refuse every save the real
  // app makes, which is far worse than the rows it would prevent.
  const created = await read(await post({ name: 'Real board', data: testBoard() }))
  assert.equal(created.status, 201, created.text)
  const { id } = created.body.board

  const saved = await read(await put(id, { name: 'Real board', data: testBoard() }))
  assert.equal(saved.status, 200, saved.text)

  // And it comes back out as a board, rather than merely having been accepted.
  const loaded = await read(await call(`/boards/${id}`, {}))
  assert.equal(loaded.status, 200, loaded.text)
  assert.equal(loaded.body.board.data.version, testBoard().version)
  assert.equal(loaded.body.board.data.tokens.length, 2)
})

test('a board written without a name is still accepted', async () => {
  // The autosave path. A client that does not know the board's title sends no
  // name at all, and the server leaves the stored one alone. The data check
  // must not have quietly made `name` load-bearing.
  const created = await read(await post({ name: 'Nameless writes', data: testBoard() }))
  const { id } = created.body.board

  const saved = await read(await put(id, { data: testBoard() }))
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.body.board.name, 'Nameless writes')
})

test('POST refuses a payload that is not a board', async () => {
  for (const data of JUNK) {
    const res = await read(await post({ name: 'Probe', data }))
    assert.equal(res.status, 400, `POST accepted ${label(data)} with ${res.status}`)
    assert.equal(res.body.field, 'data')
  }
})

test('PUT refuses the same, over a board that was fine', async () => {
  const created = await read(await post({ name: 'Good board', data: testBoard() }))
  const { id } = created.body.board

  for (const data of JUNK) {
    const res = await read(await put(id, { data }))
    assert.equal(res.status, 400, `PUT accepted ${label(data)} with ${res.status}`)
  }

  // And the board it was aimed at is untouched, which is the part that matters
  // on this endpoint: a refused write must not be a half-applied one.
  const survived = await read(await call(`/boards/${id}`, {}))
  assert.equal(survived.body.board.data.tokens.length, 2)
})

test('a missing board is still refused, and says so about the right field', async () => {
  for (const body of [{ name: 'Probe' }, { name: 'Probe', data: null }]) {
    const res = await read(await post(body))
    assert.equal(res.status, 400)
    assert.equal(res.body.field, 'data')
  }
})
