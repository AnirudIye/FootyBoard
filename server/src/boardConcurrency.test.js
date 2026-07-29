import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * Which write wins when two of them race.
 *
 * `PUT /api/boards/:id` was last-writer-wins with nothing behind it: one
 * `UPDATE ... SET data`, no compare. That is gap 10 in `handoff.md`. A member's
 * debounced autosave, carrying contents from before the owner pressed undo, is
 * in flight when the owner's undo write lands; it commits afterwards, which
 * nothing forbade, and the member's catch-up read then returned the member's own
 * stale board rather than the undone one. The owner's next autosave rewrote the
 * undone board and broadcast nothing, so the room never converged again.
 *
 * The fix is a generation on the row, and the thing to be exact about is when it
 * moves: **only on a write that also broadcasts `replaced`**. A per-write counter
 * would refuse correctly and refuse constantly, because an ordinary autosave
 * announces itself to nobody, so in a two-person room every alternating save
 * would leave the other client's base stale — each refusal costing a full board
 * read and that client's undo history, in the case where both already hold
 * identical contents because the ops flowed between them.
 *
 * So the two halves below are equally load-bearing: a stale write is refused,
 * and an ordinary one is not.
 */

const PORT = 8810
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
let user

/** A board whose striker is somewhere identifiable, so writes can be told apart. */
const boardAt = (x, y) =>
  testBoard({
    tokens: testBoard().tokens.map((t) => (t.id === 'tok-striker' ? { ...t, x, y } : t)),
  })

const strikerOf = (board) => board.data.tokens.find((t) => t.id === 'tok-striker')

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

/**
 * Status and body together, read once. A `Response` body can only be consumed
 * once, and an assertion message is evaluated whether or not it is needed.
 */
const read = async (res) => {
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null }
}

const post = (body) => call('/boards', { method: 'POST', body: JSON.stringify(body) })
const put = (id, body) => call(`/boards/${id}`, { method: 'PUT', body: JSON.stringify(body) })
const getBoard = (id) => call(`/boards/${id}`, {})

/** A board to write against, and the generation it starts on. */
async function freshBoard(name = 'Race') {
  const created = await read(await post({ name, data: boardAt(50, 50) }))
  assert.equal(created.status, 201, created.text)
  const loaded = await read(await getBoard(created.body.board.id))
  assert.equal(loaded.status, 200, loaded.text)
  return { id: created.body.board.id, generation: loaded.body.board.generation }
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
  await run('DELETE FROM boards WHERE user_id = $1', user.id)
  await run('DELETE FROM users WHERE id = $1', user.id)
  await closePool()
})

test('a board is served with the generation it is on', async () => {
  // First, because every other test here reads it. A generation that arrived as
  // a string would compare false against every number the client holds, and
  // would do it silently: `pg` hands `BIGINT` back as text.
  const { id, generation } = await freshBoard('Reads its generation')
  assert.equal(typeof generation, 'number', `generation came back as ${typeof generation}`)
  assert.ok(generation >= 1)

  const again = await read(await getBoard(id))
  assert.equal(again.body.board.generation, generation)
})

test('an ordinary save is accepted and leaves the generation alone', async () => {
  // The common case, and the half a per-write counter gets wrong. Two people
  // editing produce a steady alternation of these, and none of them may refuse
  // the other: the ops have already carried the contents to everyone, so these
  // writes agree with each other.
  const { id, generation } = await freshBoard('Ordinary saves')

  for (const x of [10, 20, 30]) {
    const saved = await read(await put(id, { data: boardAt(x, 40), baseGeneration: generation }))
    assert.equal(saved.status, 200, saved.text)
    assert.equal(saved.body.board.generation, generation)
  }

  const loaded = await read(await getBoard(id))
  assert.equal(loaded.body.board.generation, generation)
  assert.equal(strikerOf(loaded.body.board).x, 30)
})

test('a replacing save bumps the generation by one', async () => {
  const { id, generation } = await freshBoard('Replacing saves')

  const first = await read(
    await put(id, { data: boardAt(11, 11), baseGeneration: generation, replacing: true }),
  )
  assert.equal(first.status, 200, first.text)
  assert.equal(first.body.board.generation, generation + 1)

  // And the next one has to carry the new base, not the old one.
  const second = await read(
    await put(id, { data: boardAt(12, 12), baseGeneration: generation + 1, replacing: true }),
  )
  assert.equal(second.status, 200, second.text)
  assert.equal(second.body.board.generation, generation + 2)

  const loaded = await read(await getBoard(id))
  assert.equal(loaded.body.board.generation, generation + 2)
})

test('a write from a superseded generation is refused, and changes nothing', async () => {
  // The defect itself. The second assertion is the one that matters: a 409 that
  // still wrote the row would be a worse bug than no check at all, because the
  // client would then be told its write failed while the board it clobbered
  // stayed clobbered.
  const { id, generation } = await freshBoard('Superseded')

  const undo = await read(
    await put(id, { data: boardAt(20, 18), baseGeneration: generation, replacing: true }),
  )
  assert.equal(undo.status, 200, undo.text)

  const stale = await read(
    await put(id, { data: boardAt(36.05, 28.07), baseGeneration: generation }),
  )
  assert.equal(stale.status, 409, stale.text)

  const loaded = await read(await getBoard(id))
  assert.equal(strikerOf(loaded.body.board).x, 20)
  assert.equal(strikerOf(loaded.body.board).y, 18)
  assert.equal(loaded.body.board.generation, generation + 1)
})

test('a refusal says which generation the board is actually on', async () => {
  // So the client can tell a conflict from every other 4xx without parsing prose.
  const { id, generation } = await freshBoard('Says where it is')
  await read(await put(id, { data: boardAt(1, 1), baseGeneration: generation, replacing: true }))

  const stale = await read(await put(id, { data: boardAt(2, 2), baseGeneration: generation }))
  assert.equal(stale.status, 409, stale.text)
  assert.equal(stale.body.generation, generation + 1)
  assert.equal(typeof stale.body.error, 'string')
})

test('a stale base against a board that does not exist is still a 404', async () => {
  // A 409 here would answer a question the 404 exists to refuse: whether a board
  // id is real. Both endpoints already answer "no such board" identically for a
  // board somebody else owns, and adding a status that only appears for boards
  // that do exist would hand that back.
  const stale = await read(
    await put(randomUUID(), { data: boardAt(3, 3), baseGeneration: 1 }),
  )
  assert.equal(stale.status, 404, stale.text)
})

test('a write with no usable base generation is refused', async () => {
  // Required rather than optional. An optional check is one an old bundle
  // skips, and the write it would skip is exactly the one this exists to refuse.
  const { id } = await freshBoard('No base')

  for (const baseGeneration of [undefined, null, 0, -1, 1.5, 'two', {}]) {
    const res = await read(await put(id, { data: boardAt(4, 4), baseGeneration }))
    assert.equal(res.status, 400, `PUT accepted baseGeneration ${JSON.stringify(baseGeneration)}`)
    assert.equal(res.body.field, 'baseGeneration')
  }

  // Untouched by any of them.
  const loaded = await read(await getBoard(id))
  assert.equal(strikerOf(loaded.body.board).x, 50)
})

test('the room converges: the loser of the race reads the winner, not itself', async () => {
  // Gap 10 end to end, in the shape it was observed in. The owner undoes; the
  // member's autosave, carrying pre-undo contents and a base from before it,
  // lands afterwards. Before the fix that write won, and the member's catch-up
  // read handed back the member's own board.
  const { id, generation } = await freshBoard('Convergence')

  const ownerUndo = await read(
    await put(id, { data: boardAt(20, 18), baseGeneration: generation, replacing: true }),
  )
  assert.equal(ownerUndo.status, 200, ownerUndo.text)

  const memberAutosave = await read(
    await put(id, { data: boardAt(36.05, 28.07), baseGeneration: generation }),
  )
  assert.equal(memberAutosave.status, 409, memberAutosave.text)

  // The catch-up read the member does next.
  const caughtUp = await read(await getBoard(id))
  assert.equal(strikerOf(caughtUp.body.board).x, 20)

  // And having re-read, the member's next ordinary save lands on the new base.
  const afterCatchUp = await read(
    await put(id, {
      data: boardAt(21, 19),
      baseGeneration: caughtUp.body.board.generation,
    }),
  )
  assert.equal(afterCatchUp.status, 200, afterCatchUp.text)
})
