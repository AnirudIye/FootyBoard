import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, get, run, closePool } from './db.js'
import { createSession, COOKIE_NAME, hashPassword } from './auth.js'
import { guestMintingKey } from './routes/shares.js'
import { testBoard } from './testBoard.js'

/**
 * Opening a shared *link* without making an account first.
 *
 * `guestJoin.test.js` covers the same journey through the six-letter code. This
 * file covers the other door, and it exists because that door used to be shut:
 * `POST /shares/:token/redeem` began `if (!req.user) return 401`, on the argument
 * that a token is a credential and there is no redeeming one without an account
 * that would not put it back in a URL.
 *
 * **That argument does not survive the journey it describes.** The token is
 * already in a URL — a share link *is* `?share=<token>` — and the person arrived
 * holding it, so refusing them here unsent nothing. What the refusal actually
 * produced was the auth page offering "continue as a guest" and handing them a
 * blank board of their own while the shared board never opened: no error, no
 * explanation, and every appearance of having worked. And the gate stopped
 * nobody, for the same reason `/join` was corrected: `POST /api/auth/signup`
 * verifies no address, so anyone refused makes an account in five seconds and
 * redeems the same token.
 *
 * So a link admits a guest on exactly the terms a code does, and the three
 * things that made that safe for the code are the three things tested here.
 *
 * **It is asked for, never inferred.** Admission happens on `asGuest: true` and
 * not on the absence of a cookie, because a missing cookie is also what an
 * expired session looks like.
 *
 * **Nobody is created until the credential is known good.** Every failure path
 * has to return having made no account, or the endpoint is a way to fill the
 * users table by presenting rubbish.
 *
 * **One link may not mint unboundedly.** The per-share allowance is what keeps a
 * leaked link from becoming an account factory, and it is charged on the guest
 * path only.
 */

const PORT = 8828
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
let owner
let boardId
let shareId
let token

/** A documentation-range address of this suite's own — see `guestJoin.test.js`. */
const SUITE_IP = '203.0.113.223'

/** Exactly the keys this file's own requests charge. Never a prefix. */
const ownAllowanceKeys = () => [`signup:${SUITE_IP}`, `share:${SUITE_IP}`, guestMintingKey(shareId)]
const clearOwnAllowances = async () => {
  for (const key of ownAllowanceKeys()) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

const call = async (path, init = {}, cookie = null) =>
  fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': SUITE_IP,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  })

const read = async (res) => {
  const text = await res.text()
  return {
    status: res.status,
    text,
    body: text ? JSON.parse(text) : null,
    cookie: res.headers.getSetCookie?.().find((c) => c.startsWith(COOKIE_NAME)) ?? null,
  }
}

const sessionOf = (raw) => (raw ? raw.split(';')[0] : null)

/** The call under test. `body` is omitted entirely when not admitting a guest. */
const redeem = async (value, { asGuest = false, cookie = null } = {}) => {
  await clearOwnAllowances()
  return read(
    await call(
      `/shares/${encodeURIComponent(value)}/redeem`,
      { method: 'POST', ...(asGuest ? { body: JSON.stringify({ asGuest: true }) } : {}) },
      cookie,
    ),
  )
}

/**
 * Guests admitted to *this* suite's board, not every guest in the database.
 *
 * Scoped for the reason `guestJoin.test.js` scopes it: the suites run
 * concurrently against one dev database, and an unscoped count reads whatever a
 * neighbour is mid-way through creating. Sound rather than merely convenient,
 * because `admitAsGuest` writes the user row and the membership row in one
 * transaction — so "nobody was admitted here" and "nobody was created" are the
 * same number.
 */
const guestCount = async () =>
  Number(
    (
      await get(
        `SELECT count(*)::int AS n
           FROM users u
           JOIN board_members m ON m.user_id = u.id
          WHERE u.is_guest = true AND m.board_id = $1`,
        boardId,
      )
    ).n,
  )

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

before(async () => {
  await migrate()

  const id = randomUUID()
  const { hash, salt } = await hashPassword('OwnerPass!8828')
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    id,
    `${id}@test.invalid`,
    hash,
    salt,
    new Date().toISOString(),
  )
  owner = { id, cookie: `${COOKIE_NAME}=${await createSession(id)}` }

  child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${PORT}`,
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    if (!text.includes('ENCRYPTION_KEY')) process.stderr.write(`[${PORT}] ${text}`)
  })
  await waitForHealth()

  const created = await read(
    await call(
      '/boards',
      { method: 'POST', body: JSON.stringify({ name: 'Shared session', data: testBoard() }) },
      owner.cookie,
    ),
  )
  assert.equal(created.status, 201, created.text)
  boardId = created.body.board.id

  const shared = await read(await call(`/boards/${boardId}/share`, { method: 'POST' }, owner.cookie))
  assert.equal(shared.status, 201, shared.text)
  token = shared.body.share.token
  shareId = shared.body.share.id
  assert.ok(token, 'the share came back with no link token')
})

after(async () => {
  child?.kill()
  await run('DELETE FROM boards WHERE user_id = $1', owner.id)
  await run('DELETE FROM users WHERE id = $1', owner.id)
  await run(
    `DELETE FROM users
      WHERE is_guest = true
        AND id IN (SELECT user_id FROM board_members WHERE board_id = $1)`,
    boardId,
  )
  for (const key of ownAllowanceKeys()) await run('DELETE FROM login_attempts WHERE key = $1', key)
  await closePool()
})

test('a link admits a guest, and hands back a session and the board it names', async () => {
  const before = await guestCount()
  const res = await redeem(token, { asGuest: true })

  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.board.id, boardId)
  assert.ok(res.cookie, 'no session cookie came back, so the guest cannot open anything')
  assert.equal(await guestCount(), before + 1)
})

test('the guest it made is a real member, not a visitor who saw the board once', async () => {
  const res = await redeem(token, { asGuest: true })
  assert.equal(res.status, 200, res.text)

  // The board is readable with the cookie alone, which is the whole point:
  // membership is a row, not a claim carried in the URL.
  const board = await read(await call(`/boards/${boardId}`, {}, sessionOf(res.cookie)))
  assert.equal(board.status, 200, board.text)
  assert.equal(board.body.board.id, boardId)
})

test('the account it made has no address and no password, so nothing can sign into it', async () => {
  const res = await redeem(token, { asGuest: true })
  assert.equal(res.status, 200, res.text)

  const me = await read(await call('/auth/me', {}, sessionOf(res.cookie)))
  assert.equal(me.status, 200, me.text)

  const row = await get(
    `SELECT u.email, u.password_hash, u.password_salt, u.is_guest
       FROM users u
       JOIN board_members m ON m.user_id = u.id
      WHERE m.board_id = $1 AND u.is_guest = true
      ORDER BY u.created_at DESC
      LIMIT 1`,
    boardId,
  )
  assert.equal(row.email, null)
  assert.equal(row.password_hash, null)
  assert.equal(row.password_salt, null)
  assert.equal(row.is_guest, true)
})

test('admission is asked for, never inferred from a missing cookie', async () => {
  const before = await guestCount()
  // A valid token, no cookie, and no flag. This is exactly what an expired
  // session looks like, and answering it with a brand new empty account would
  // walk somebody away from every board they own without a word.
  const res = await redeem(token)

  assert.equal(res.status, 401, res.text)
  assert.match(res.body.error, /sign in/i)
  assert.equal(res.cookie, null, 'a session was issued to a request that did not ask to be a guest')
  assert.equal(await guestCount(), before, 'an account was created without being asked for')
})

test('a wrong token creates nobody', async () => {
  const before = await guestCount()
  const res = await redeem('not-a-real-token-at-all', { asGuest: true })

  assert.equal(res.status, 404, res.text)
  assert.equal(res.cookie, null)
  assert.equal(await guestCount(), before, 'presenting rubbish minted an account')
})

test('a signed-in caller still redeems as themselves, and is not turned into a guest', async () => {
  const id = randomUUID()
  const { hash, salt } = await hashPassword('MemberPass!8828')
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    id,
    `${id}@test.invalid`,
    hash,
    salt,
    new Date().toISOString(),
  )
  const cookie = `${COOKIE_NAME}=${await createSession(id)}`

  const before = await guestCount()
  // `asGuest` is sent as well, to prove the cookie wins. Somebody arriving from
  // the guest door with a live session must join as themselves rather than be
  // handed a second, empty account holding none of their work.
  const res = await redeem(token, { asGuest: true, cookie })

  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.board.id, boardId)
  assert.equal(await guestCount(), before, 'a signed-in caller was minted a guest account')

  const member = await get(
    'SELECT user_id FROM board_members WHERE board_id = $1 AND user_id = $2',
    boardId,
    id,
  )
  assert.ok(member, 'the signed-in caller did not become a member')

  await run('DELETE FROM users WHERE id = $1', id)
})

test('the per-share allowance is what bounds a leaked link, and it is charged', async () => {
  // Not exhausted here — 200 accounts is not a unit test. What matters is that
  // the guest path spends this counter at all: unspent, a link that got out is
  // an unbounded account factory, and the guessing counter above it cannot help
  // because a real token is never a guess.
  await run('DELETE FROM login_attempts WHERE key = $1', guestMintingKey(shareId))

  const res = await redeem(token, { asGuest: true })
  assert.equal(res.status, 200, res.text)

  const charged = await get(
    'SELECT count FROM login_attempts WHERE key = $1',
    guestMintingKey(shareId),
  )
  assert.ok(charged, 'redeeming as a guest charged no minting allowance')
  assert.ok(Number(charged.count) >= 1)
})

test('a signed-in redemption does not charge the guest allowance', async () => {
  await run('DELETE FROM login_attempts WHERE key = $1', guestMintingKey(shareId))

  const res = await redeem(token, { cookie: owner.cookie })
  assert.equal(res.status, 200, res.text)

  const charged = await get(
    'SELECT count FROM login_attempts WHERE key = $1',
    guestMintingKey(shareId),
  )
  assert.equal(charged, null, 'a member redeeming spent the allowance meant for minting guests')
})

/**
 * Last on purpose: it revokes this file's share, so every test above needs to
 * have run first.
 *
 * The first draft put it in the middle and it failed the three tests after it,
 * all with "That link is not valid any more" — which read as the change being
 * broken and was the fixture being destroyed. `DELETE /boards/:id/share` removes
 * the board's share row, and that row is what `token` belongs to.
 */
test('a revoked link creates nobody, and says only that it is not valid', async () => {
  const gone = await read(await call(`/boards/${boardId}/share`, { method: 'DELETE' }, owner.cookie))
  assert.ok(gone.status === 200 || gone.status === 204, gone.text)

  const before = await guestCount()
  const res = await redeem(token, { asGuest: true })

  assert.equal(res.status, 404, res.text)
  // The same sentence a token that never existed gets. A revoked link must not
  // be distinguishable from a wrong one, or the endpoint answers "this was real
  // once" for free.
  assert.match(res.body.error, /not valid any more/i)
  assert.equal(await guestCount(), before, 'a revoked link still minted an account')
})
