import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, get, run, closePool } from './db.js'
import { createSession, COOKIE_NAME, hashPassword } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * Joining a shared board without making an account first.
 *
 * The old journey had a third door: somebody typed a code, was asked for an
 * account, chose "continue as a guest", and landed on a blank board of their
 * own. The code travelled with them so they could finish later, which was an
 * improvement on losing it, and it still was not what they came for. The
 * standing argument for that was "membership attaches to a person rather than a
 * browser", and it does not survive contact with `POST /api/auth/signup`, which
 * verifies no address at all: the account gate stopped nobody who wanted through
 * it, so it was a constraint on the data model rather than a barrier.
 *
 * So a guest gets an account, with no address and no password, and a real
 * `board_members` row. Three things about that are load-bearing and each has
 * tests here.
 *
 * **It is asked for, never inferred.** Admission happens on `asGuest: true` and
 * not on the absence of a cookie, because a missing cookie is also what an
 * expired session looks like — and silently turning that person into a fresh
 * guest would walk them away from their own boards without a word.
 *
 * **A credential-less account must not be reachable by credentials.** A row with
 * a null email and a null password hash has to be unloginable, unrecoverable and
 * unchangeable, and the failure mode if it is not is an authentication bypass
 * rather than a bug.
 *
 * **Their work must not be stranded.** Everything a guest saves lives under an
 * account nobody can sign back into, so `POST /api/auth/claim` attaches real
 * credentials to the account already holding the work rather than making a
 * second one.
 */

const PORT = 8811
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
let owner
let boardId
let code

/**
 * A documentation-range address, so this suite owns the allowances it spends.
 *
 * Every suite reaches the API from 127.0.0.1, so `signup:127.0.0.1` and
 * `join:127.0.0.1` are one counter each for the whole concurrent run. This file
 * used to cope by sweeping `signup:%` and `join:%` before every request that
 * spends one, and **that wildcard was the bug rather than the fix**: it reached
 * `join:203.0.113.7`, the counter `sharing.integration.test.js` spends fifteen
 * wrong codes into, and wiping it mid-loop restarted that count at one so the
 * fifteenth guess never tripped a limit of ten. Measured at roughly half of all
 * runs. Declaring a proxy and sending an address nobody else uses is the same
 * mechanism `npm run cluster` uses and gives this file a bucket of its own, so
 * the reset below can name two exact keys and reach nothing it does not own.
 *
 * Above .200 deliberately: `rateLimit.test.js` writes `ip:203.0.113.N` rows for
 * a random N up to 200.
 */
const SUITE_IP = '203.0.113.219'

/** Exactly the two keys this file's own requests charge. Never a prefix. */
const OWN_ALLOWANCE_KEYS = [`signup:${SUITE_IP}`, `join:${SUITE_IP}`]
const clearOwnAllowances = async () => {
  for (const key of OWN_ALLOWANCE_KEYS) await run('DELETE FROM login_attempts WHERE key = $1', key)
}

/**
 * Paths whose handlers charge a per-IP allowance this file would otherwise
 * exhaust.
 *
 * It is still reset before each spending request rather than once in `before()`:
 * this file alone makes more than the ten an hour those allowances permit, so a
 * single clear at the start just moves which test collects the 429. What has
 * changed is that the reset is now scoped to this suite's own address, so the
 * cost is paid here instead of by whichever neighbour was counting.
 */
const SPENDS_ALLOWANCE = ['/auth/signup', '/auth/claim', '/shares/join']

const call = async (path, init = {}, cookie = null) => {
  if (SPENDS_ALLOWANCE.includes(path)) await clearOwnAllowances()
  return fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': SUITE_IP,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
}

const read = async (res) => {
  const text = await res.text()
  return {
    status: res.status,
    text,
    body: text ? JSON.parse(text) : null,
    cookie: res.headers.getSetCookie?.().find((c) => c.startsWith(COOKIE_NAME)) ?? null,
  }
}

/** The session cookie out of a `set-cookie`, in the form a request wants back. */
const sessionOf = (raw) => (raw ? raw.split(';')[0] : null)

const joinAsGuest = (value) =>
  call('/shares/join', { method: 'POST', body: JSON.stringify({ code: value, asGuest: true }) })

/**
 * Guests admitted to *this* suite's board, not every guest in the database.
 *
 * The unscoped count read whatever a concurrently running file happened to have
 * created, so "a wrong code creates nobody" compared two numbers that something
 * else was moving. Scoping it to the board is sound rather than a convenience:
 * `admitAsGuest` writes the user row and the membership row in **one
 * transaction**, so a guest with no membership cannot be observed, and "nobody
 * was admitted here" and "nobody was created" are the same count.
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

  // The per-IP join allowance is a Postgres row and outlives a test run, so a
  // second run would start partway through it and collect a surprise 429.
  await clearOwnAllowances()

  const id = randomUUID()
  const { hash, salt } = await hashPassword('OwnerPass!8891')
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
      // Without this `req.ip` is the socket address and the header above is
      // ignored, so this suite would silently be back in the shared bucket.
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => {
    const text = String(d)
    if (!text.includes('ENCRYPTION_KEY')) process.stderr.write(`[${PORT}] ${text}`)
  })
  await waitForHealth()

  // A board with sharing on, which is what produces a code.
  const created = await read(
    await call('/boards', {
      method: 'POST',
      body: JSON.stringify({ name: 'Session board', data: testBoard() }),
    }, owner.cookie),
  )
  assert.equal(created.status, 201, created.text)
  boardId = created.body.board.id

  const shared = await read(
    await call(`/boards/${boardId}/share`, { method: 'POST' }, owner.cookie),
  )
  assert.equal(shared.status, 201, shared.text)
  code = shared.body.share.code
  assert.ok(code, 'the share came back with no join code')
})

after(async () => {
  child?.kill()
  // Guests created here own no boards, but they do hold membership rows, and
  // those cascade from the user. Boards first, then every account this file made.
  await run('DELETE FROM boards WHERE user_id = $1', owner.id)
  await run('DELETE FROM users WHERE id = $1', owner.id)
  /**
   * Only the guests this file made, found through the board it owns.
   *
   * This was `WHERE is_guest = true`, which is every guest in the database. The
   * suites run concurrently against one dev database, so that reached into
   * whatever else was mid-run and deleted its guests underneath it: the symptom
   * was another file's "the owner sees a name for every member" failing while
   * passing perfectly on its own. A cleanup wide enough to break a neighbour is
   * not a cleanup.
   *
   * Membership is the handle rather than a list of ids kept in memory, because it
   * is already the record of who this board admitted and cannot drift from it.
   */
  await run(
    `DELETE FROM users
      WHERE is_guest = true
        AND id IN (SELECT user_id FROM board_members WHERE board_id = $1)`,
    boardId,
  )
  await clearOwnAllowances()
  await closePool()
})

test('a guest asking with a good code lands on the board, with a session', async () => {
  const joined = await read(await joinAsGuest(code))
  assert.equal(joined.status, 200, joined.text)
  assert.equal(joined.body.board.id, boardId)
  assert.ok(sessionOf(joined.cookie), 'no session cookie came back')

  // And it is real membership rather than a one-off answer: the board reads.
  const board = await read(await call(`/boards/${boardId}`, {}, sessionOf(joined.cookie)))
  assert.equal(board.status, 200, board.text)
  assert.equal(board.body.board.data.tokens.length, 2)
  assert.equal(board.body.board.role, 'member')
})

test('the guest is reported as a guest, and has no address', async () => {
  const joined = await read(await joinAsGuest(code))
  const me = await read(await call('/auth/me', {}, sessionOf(joined.cookie)))

  assert.equal(me.status, 200, me.text)
  assert.equal(me.body.user.isGuest, true)
  assert.equal(me.body.user.email, null)
  assert.ok(me.body.user.id)
})

test('admission is asked for, never inferred from a missing cookie', async () => {
  // A missing cookie is also what an expired session looks like. Turning that
  // person into a brand new guest would walk them away from their own boards
  // and their own work without saying anything, so the plain call still 401s.
  const before = await guestCount()
  const plain = await read(
    await call('/shares/join', { method: 'POST', body: JSON.stringify({ code }) }),
  )

  assert.equal(plain.status, 401, plain.text)
  assert.equal(await guestCount(), before, 'a guest was created without being asked for')
})

test('a wrong code creates nobody', async () => {
  // Otherwise the endpoint is a way to fill the users table by guessing, and the
  // guessing is already what the allowance is there to stop.
  const before = await guestCount()
  const wrong = await read(await joinAsGuest('ZZZZZZ'))

  assert.equal(wrong.status, 404, wrong.text)
  assert.equal(await guestCount(), before)
})

test('a malformed code creates nobody either', async () => {
  const before = await guestCount()
  for (const bad of ['', 'abc', '123456', null]) {
    const res = await read(await joinAsGuest(bad))
    assert.ok(res.status >= 400, `${JSON.stringify(bad)} was accepted with ${res.status}`)
  }
  assert.equal(await guestCount(), before)
})

test('a guest account cannot be reached by any credential path', async () => {
  // This is the one that would be an authentication bypass rather than a bug.
  // The row has a null email and a null password hash, and every path that
  // takes an address has to miss it rather than match loosely on null.
  const joined = await read(await joinAsGuest(code))
  const guest = sessionOf(joined.cookie)

  const login = await read(
    await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: '', password: 'anything at all' }),
    }),
  )
  assert.ok(login.status >= 400, `an empty address logged in with ${login.status}`)

  // Changing a password needs a current one to verify, and there is none.
  const change = await read(
    await call('/auth/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: 'anything at all',
        password: 'Newpass!7712',
        securityQuestionId: 'first-pet',
        securityAnswer: 'rex',
      }),
    }, guest),
  )
  assert.ok(change.status >= 400, `a guest changed a password with ${change.status}`)

  // And recovery has no address to start from.
  const forgot = await read(
    await call('/auth/forgot', { method: 'POST', body: JSON.stringify({ email: '' }) }),
  )
  assert.ok(forgot.status >= 400, `recovery started with no address: ${forgot.status}`)
})

test('a guest keeps their boards when they attach real credentials', async () => {
  // The work-loss trap this whole thing would otherwise create: everything a
  // guest saves lives under an account nobody can sign back into. Claiming
  // attaches credentials to the account already holding the work rather than
  // making a second one beside it.
  const joined = await read(await joinAsGuest(code))
  const guest = sessionOf(joined.cookie)
  const me = await read(await call('/auth/me', {}, guest))
  const guestId = me.body.user.id

  const address = `claimed-${randomUUID()}@test.invalid`
  const claimed = await read(
    await call('/auth/claim', {
      method: 'POST',
      body: JSON.stringify({
        email: address,
        password: 'Claimed!7712',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
        // Required here as it is at signup: this account is gaining an address,
        // and presence falls back to the address when nobody has chosen a name.
        // See `displayName.test.js`.
        displayName: 'Claimed Coach',
      }),
    }, guest),
  )
  assert.equal(claimed.status, 200, claimed.text)

  // The same account, not a new one. That is the whole point.
  const after = await read(await call('/auth/me', {}, guest))
  assert.equal(after.body.user.id, guestId, 'claiming made a different account')
  assert.equal(after.body.user.isGuest, false)
  assert.equal(after.body.user.email, address)

  // Still a member of the board they joined as a guest.
  const board = await read(await call(`/boards/${boardId}`, {}, guest))
  assert.equal(board.status, 200, board.text)

  // And now reachable by the credentials they just set.
  const login = await read(
    await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: address, password: 'Claimed!7712' }),
    }),
  )
  assert.equal(login.status, 200, login.text)
})

test('claiming is refused for an account that already has credentials', async () => {
  // Otherwise it is an unauthenticated password change for anybody holding a
  // session: no current password asked for, because a guest has none.
  const res = await read(
    await call('/auth/claim', {
      method: 'POST',
      body: JSON.stringify({
        email: `hijack-${randomUUID()}@test.invalid`,
        password: 'Hijacked!7712',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
        displayName: 'Hijacker',
      }),
    }, owner.cookie),
  )
  assert.ok(res.status >= 400, `a real account was re-claimed with ${res.status}`)
})

test('claiming an address somebody already has leaves the guest a guest', async () => {
  const joined = await read(await joinAsGuest(code))
  const guest = sessionOf(joined.cookie)
  const taken = (await get('SELECT email FROM users WHERE id = $1', owner.id)).email

  const res = await read(
    await call('/auth/claim', {
      method: 'POST',
      body: JSON.stringify({
        email: taken,
        password: 'Collide!7712',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
        displayName: 'Collider',
      }),
    }, guest),
  )
  assert.equal(res.status, 400, res.text)

  // Half-claimed would be the worst outcome: an account with an address it does
  // not own, or credentials set with is_guest still true.
  const me = await read(await call('/auth/me', {}, guest))
  assert.equal(me.body.user.isGuest, true)
  assert.equal(me.body.user.email, null)
})

test('the room is told a name for a guest, not a blank', async () => {
  /**
   * A guest has a null address, so `identity()` has nothing to disclose and
   * substitutes the generated name it already assigns everyone. Two things are
   * being asserted and only one is obvious. The obvious one: no address travels,
   * which is free here because there is not one. The other: the peer arrives with
   * a name at all. `{ email: null }` leaks nothing and draws an unlabelled cursor,
   * and carrying the field is only worth anything if a peer can put it beside a
   * pointer.
   *
   * This board has anonymous presence OFF, which is the default and is the case
   * that would otherwise have handed the room a null.
   */
  const joined = await read(await joinAsGuest(code))
  const guest = sessionOf(joined.cookie)

  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?board=${boardId}`, {
    headers: { Cookie: guest },
  })
  try {
    const welcome = await new Promise((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw)
        if (message.type === 'welcome') resolve(message)
      })
      socket.once('close', (c) => reject(new Error(`closed ${c}`)))
      socket.once('error', reject)
      setTimeout(() => reject(new Error('no welcome within 4s')), 4000)
    })

    assert.equal(welcome.role, 'member')

    /**
     * The owner joins second and finds the guest in its own `welcome` roster.
     *
     * Not `peer-present`: that is the answer to the client-driven `here`
     * introduction, which exists because a roster only covers the instance that
     * answered, and these raw sockets do not perform it. One instance, so the
     * roster is the payload that names the guest.
     */
    const ownerSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?board=${boardId}`, {
      headers: { Cookie: owner.cookie },
    })
    try {
      const ownerWelcome = await new Promise((resolve, reject) => {
        ownerSocket.on('message', (raw) => {
          const message = JSON.parse(raw)
          if (message.type === 'welcome') resolve(message)
        })
        ownerSocket.once('close', (c) => reject(new Error(`closed ${c}`)))
        ownerSocket.once('error', reject)
        setTimeout(() => reject(new Error('no welcome within 4s')), 4000)
      })

      const peer = ownerWelcome.peers.find((p) => p.id === welcome.peerId)
      assert.ok(peer, 'the guest was not in the roster at all')
      assert.ok(peer.displayName, 'the guest arrived with no name')
      assert.doesNotMatch(peer.displayName, /@/)
      assert.match(peer.displayName, /^Anonymous /)
      assert.equal(peer.email, peer.displayName)
    } finally {
      ownerSocket.close()
    }
  } finally {
    socket.close()
  }
})

test('two guests joining the same code are two different accounts', async () => {
  // One row per person, so removing one member does not eject the rest and the
  // roster names them separately.
  const a = await read(await joinAsGuest(code))
  const b = await read(await joinAsGuest(code))

  const meA = await read(await call('/auth/me', {}, sessionOf(a.cookie)))
  const meB = await read(await call('/auth/me', {}, sessionOf(b.cookie)))
  assert.notEqual(meA.body.user.id, meB.body.user.id)

  const members = await read(await call(`/boards/${boardId}/members`, {}, owner.cookie))
  assert.equal(members.status, 200, members.text)
  const ids = members.body.members.map((m) => m.id)
  assert.ok(ids.includes(meA.body.user.id))
  assert.ok(ids.includes(meB.body.user.id))
})
