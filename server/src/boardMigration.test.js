import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { testBoard } from './testBoard.js'
import { SCHEMA_VERSION } from '../../src/lib/boardSchema.js'

/**
 * Which schema versions the write path will take.
 *
 * `isPersistedBoard` compared the version for equality, so the day
 * `SCHEMA_VERSION` moved, every row already in the database stopped being a
 * board — for the client on read, and for this endpoint on write. The client
 * half of that is the catastrophic one and is held in `persistence.test.ts` and
 * `boardSync.test.ts`. This file holds the end nobody would notice until a
 * deploy: the two ends share one function, so widening the client's guard
 * necessarily widened the server's, and the question is whether that widening
 * let anything in that it should not have.
 *
 * The direction matters. A server stricter than the client's own serialiser
 * refuses every save the real app makes, for everybody, from the first
 * keystroke, so **older is accepted**: a bundle still running the previous
 * schema keeps saving through a deploy, and the next client to read the row
 * brings it forward. **Newer is refused**, because a payload from a build this
 * one knows nothing about is one it cannot upgrade and must not guess at.
 *
 * Note what the server deliberately does not do: it stores what it was given
 * rather than upgrading on write. Upgrading here would mean the API rewriting
 * board contents nobody asked it to touch, on a row whose generation says it
 * was not replaced. The cost is that an old row stays old until a client opens
 * and saves it, which is exactly what `upgradeBoard` is for.
 */

const PORT = 8813
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
let user

/** A board exactly as version 1 wrote it: no `bench`, and `view.snap` present. */
function storedAtV1() {
  const { bench: _bench, ...board } = testBoard()
  return { ...board, version: 1, view: { ...board.view, snap: false } }
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

const call = (path, init) =>
  fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: { Cookie: user.cookie, 'Content-Type': 'application/json' },
  })

const post = (body) => call('/boards', { method: 'POST', body: JSON.stringify(body) })

/**
 * Every write states the base it was made on. Nothing here replaces a whole
 * board, so 1 is always the current base and a refusal below is about the
 * payload rather than about a stale generation.
 */
const put = (id, body) =>
  call(`/boards/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ baseGeneration: 1, ...body }),
  })

/** Status and body together: a `Response` body can only be read once. */
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
  // This account's rows go with it. The dev database is already carrying eight
  // unopenable rows that suites like this one left behind, and the version-1
  // board written below would be a ninth confusing thing to find in there.
  await run('DELETE FROM boards WHERE user_id = $1', user.id)
  await run('DELETE FROM users WHERE id = $1', user.id)
  await closePool()
})

test('a board a current client writes is still accepted', async () => {
  // First, because everything else here is only worth having if this holds.
  const created = await read(await post({ name: 'Current board', data: testBoard() }))
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.board.id.length > 0, true)
})

test('a board written by an older version is accepted, on both endpoints', async () => {
  const created = await read(await post({ name: 'Older board', data: storedAtV1() }))
  assert.equal(created.status, 201, created.text)
  const { id } = created.body.board

  const saved = await read(await put(id, { name: 'Older board', data: storedAtV1() }))
  assert.equal(saved.status, 200, saved.text)

  // And it comes back exactly as it went in. The upgrade belongs to whichever
  // client opens it, so a row that was written at version 1 is still at version
  // 1 when it is read: the API does not quietly rewrite stored contents.
  const loaded = await read(await call(`/boards/${id}`, {}))
  assert.equal(loaded.status, 200, loaded.text)
  assert.equal(loaded.body.board.data.version, 1)
  assert.equal('bench' in loaded.body.board.data, false)
})

test('a board from a version newer than this build is refused', async () => {
  // The direction that has to stay closed. A payload from a build this one knows
  // nothing about cannot be upgraded, so accepting it would mean storing
  // contents no reader here can make sense of.
  for (const version of [SCHEMA_VERSION + 1, SCHEMA_VERSION + 9]) {
    const res = await read(await post({ name: 'From the future', data: testBoard({ version }) }))
    assert.equal(res.status, 400, `POST accepted version ${version} with ${res.status}`)
    assert.equal(res.body.field, 'data')
  }
})

test('a version number on its own is still not a board', async () => {
  // The shapes the dev database actually collected, two of which are at version
  // 1 (`probe board`) and four of which decrypt to `{"v":1}`. Accepting older
  // versions is exactly the change that could have let those in, and it must
  // not have: they are refused on shape.
  const created = await read(await post({ name: 'Good board', data: testBoard() }))
  const { id } = created.body.board

  for (const data of [{ v: 1 }, { version: 1 }, { version: 2 }, { version: SCHEMA_VERSION }]) {
    const posted = await read(await post({ name: 'Probe', data }))
    assert.equal(posted.status, 400, `POST accepted ${JSON.stringify(data)}`)
    assert.equal(posted.body.field, 'data')

    const written = await read(await put(id, { data }))
    assert.equal(written.status, 400, `PUT accepted ${JSON.stringify(data)}`)
    assert.equal(written.body.field, 'data')
  }

  // The board those writes were aimed at is untouched, which is the part that
  // matters on `PUT`: a refused write must not be a half-applied one.
  const survived = await read(await call(`/boards/${id}`, {}))
  assert.equal(survived.body.board.data.tokens.length, 2)
})
