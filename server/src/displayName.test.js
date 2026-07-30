import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { migrate, run, closePool } from './db.js'
import { createSession, COOKIE_NAME, hashPassword } from './auth.js'
import { testBoard } from './testBoard.js'

/**
 * A name people choose for themselves, and what the room is told instead.
 *
 * The gap this closes: presence named a signed-up member by their address, and
 * the only way out was the owner's per-board "Anonymous guests" switch, which is
 * off by default. So a code read aloud to a hall put every member's local part on
 * every other member's screen unless the owner had thought about it.
 *
 * Four rules, in order, and the order is the feature:
 *
 *   1. the board hides addresses  -> the generated animal name. The owner's
 *      decision about their room outranks anybody's preference about themselves;
 *   2. a display name is set      -> the display name;
 *   3. there is no address at all -> the generated animal name (a guest);
 *   4. otherwise                  -> the address, exactly as before.
 *
 * Rule 4 is the residual gap and is asserted here rather than left implied:
 * accounts that existed before this feature carry a null `display_name` and go
 * on showing a local part until somebody sets one. There is no way to invent a
 * name on their behalf, which is the same shape as the security-question
 * backfill. Test "an account with no display name is named the way it always
 * was" is that gap written down, and it asserts the leak positively so that
 * closing it later has to be a deliberate change rather than a surprise.
 *
 * The `@` refusal is not fussiness about punctuation. `anonymousPresence.test.js`
 * asserts bluntly that no `@` appears anywhere in three sockets' traffic, and
 * that assertion is only worth something if a display name cannot carry one:
 * otherwise the invariant becomes a hope about what people type.
 *
 * Its own port, because `node --test` runs files concurrently and :8799 to :8813
 * are already spoken for.
 */

const PORT = 8814
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
/** Every account this file creates, so `after` can take them all out again. */
const made = []
let owner
let named
let plain
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
const SUITE_IP = '203.0.113.220'

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

/**
 * An account made directly rather than through `/signup`.
 *
 * The signup route is where the field is *required*, and that is tested on its
 * own below. Here the point is what the relay does with a row, so the rows are
 * written as they are: with a name, or with the null a pre-existing account has.
 */
async function makeUser({ displayName = null } = {}) {
  const id = randomUUID()
  const email = `${id}@test.invalid`
  const { hash, salt } = await hashPassword('Displayed!8814')
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        display_name)
     VALUES ($1, $2, $3, $4, $5, $5, $6)`,
    id,
    email,
    hash,
    salt,
    new Date().toISOString(),
    displayName,
  )
  made.push(id)
  return { id, email, displayName, cookie: `${COOKIE_NAME}=${await createSession(id)}` }
}

/** Resolves on `welcome`, which is the server saying the room is actually yours. */
async function openSocket(board, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?board=${board}`, {
    headers: { Cookie: cookie },
  })
  socket.received = []
  socket.on('message', (raw) => socket.received.push(JSON.parse(raw)))

  await new Promise((resolve, reject) => {
    socket.on('message', function first(raw) {
      if (JSON.parse(raw).type !== 'welcome') return
      socket.off('message', first)
      resolve()
    })
    socket.once('close', (c) => reject(new Error(`closed ${c}`)))
    socket.once('error', reject)
    setTimeout(() => reject(new Error('no welcome within 4s')), 4000)
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

const setDisplayName = (value, cookie) =>
  call('/auth/display-name', { method: 'PATCH', body: JSON.stringify({ displayName: value }) }, cookie)

const joinAsGuest = () =>
  call('/shares/join', { method: 'POST', body: JSON.stringify({ code, asGuest: true }) })

/** A guest, admitted by the code, with the session it came back with. */
async function admitGuest() {
  const joined = await read(await joinAsGuest())
  assert.equal(joined.status, 200, joined.text)
  const cookie = sessionOf(joined.cookie)
  const me = await read(await call('/auth/me', {}, cookie))
  assert.equal(me.status, 200, me.text)
  made.push(me.body.user.id)
  return { id: me.body.user.id, cookie }
}

const ANONYMOUS_NAME = /^Anonymous [A-Z][a-z]+$/

before(async () => {
  await migrate()

  // Both allowances are Postgres rows and outlive a run, so a second run would
  // start partway through one and collect a surprise 429.
  await clearOwnAllowances()

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

  owner = await makeUser({ displayName: 'Head Coach' })
  named = await makeUser({ displayName: 'Coach Vera' })
  // The account this feature cannot help: it existed before the column did.
  plain = await makeUser()

  const created = await read(
    await call(
      '/boards',
      { method: 'POST', body: JSON.stringify({ name: 'Session board', data: testBoard() }) },
      owner.cookie,
    ),
  )
  assert.equal(created.status, 201, created.text)
  boardId = created.body.board.id

  const shared = await read(
    await call(`/boards/${boardId}/share`, { method: 'POST' }, owner.cookie),
  )
  assert.equal(shared.status, 201, shared.text)
  code = shared.body.share.code

  // Admitted directly rather than through the code: how these two got in is not
  // what this file is about, and redeeming spends an allowance.
  for (const member of [named, plain]) {
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
  child?.kill()
  // Boards first: memberships and shares cascade from the board, and every
  // account this file made goes by id rather than by a blanket delete, because
  // another suite may be holding guests of its own in this same database.
  if (owner) await run('DELETE FROM boards WHERE user_id = $1', owner.id)
  for (const id of made) await run('DELETE FROM users WHERE id = $1', id)
  await clearOwnAllowances()
  await closePool()
})

test('a chosen display name is what the room is told, instead of the address', async () => {
  const a = await openSocket(boardId, owner.cookie)
  const b = await openSocket(boardId, named.cookie)

  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.displayName, 'Coach Vera')
  assert.equal(joined.email, 'Coach Vera', 'the disclosed field is the name, not the address')

  // Both directions, and bluntly: the owner has a name too, so nothing either
  // socket was handed should contain an address at all.
  for (const socket of [a, b]) {
    assert.equal(
      JSON.stringify(socket.received).includes('@'),
      false,
      'an address reached a client although both accounts have chosen names',
    )
  }

  await Promise.all([closed(a), closed(b)])
})

test('an account with no display name is named the way it always was', async () => {
  /**
   * Rule 4, which is the residual gap rather than a feature.
   *
   * An account created before this existed has a null `display_name`, and there
   * is no name to invent on its behalf, so it keeps disclosing its address until
   * somebody chooses one. Asserted positively — the address really is on the
   * wire — so that closing this later is a deliberate change to a test rather
   * than a surprise to whoever finds it.
   */
  const a = await openSocket(boardId, owner.cookie)
  const b = await openSocket(boardId, plain.cookie)

  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.displayName, plain.email)
  assert.equal(joined.email, plain.email)
  assert.equal(
    JSON.stringify(a.received).includes('@'),
    true,
    'this is the gap: an account with no chosen name still discloses its address',
  )

  await Promise.all([closed(a), closed(b)])
})

test('anonymous presence still wins over a chosen display name', async () => {
  // The owner is deciding what this room discloses, which outranks what anybody
  // would like to be called in it. Set with the room empty, so the next socket
  // reads the row rather than a cached flag.
  const on = await read(await call(
    `/boards/${boardId}/anonymous`,
    { method: 'PATCH', body: JSON.stringify({ anonymous: true }) },
    owner.cookie,
  ))
  assert.equal(on.status, 200, on.text)

  const a = await openSocket(boardId, owner.cookie)
  const b = await openSocket(boardId, named.cookie)

  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.match(joined.displayName, ANONYMOUS_NAME)
  assert.notEqual(joined.displayName, 'Coach Vera', 'the chosen name overrode the owner')
  assert.match(joined.email, ANONYMOUS_NAME)

  await Promise.all([closed(a), closed(b)])

  const off = await read(await call(
    `/boards/${boardId}/anonymous`,
    { method: 'PATCH', body: JSON.stringify({ anonymous: false }) },
    owner.cookie,
  ))
  assert.equal(off.status, 200, off.text)
})

test('a display name containing an @ is refused, and changes nothing', async () => {
  // Not paternalism. `anonymousPresence.test.js` asserts no `@` reaches the
  // wire, and a name that may contain one turns that from a property of the
  // system into a hope about what people type.
  const res = await read(await setDisplayName('coach@example.com', named.cookie))
  assert.equal(res.status, 400, res.text)
  assert.equal(res.body.field, 'displayName')

  const me = await read(await call('/auth/me', {}, named.cookie))
  assert.equal(me.body.user.displayName, 'Coach Vera', 'a refused name was stored anyway')
})

test('a display name has to be a name', async () => {
  // A name made only of control characters is empty once cleaned, and a number
  // is not text at all: both are refusals rather than something to coerce.
  for (const bad of ['', '   ', '', 'x'.repeat(200), null, 42]) {
    const res = await read(await setDisplayName(bad, named.cookie))
    assert.equal(res.status, 400, `${JSON.stringify(bad)} was accepted with ${res.status}`)
  }

  const me = await read(await call('/auth/me', {}, named.cookie))
  assert.equal(me.body.user.displayName, 'Coach Vera')
})

test('changing it is a change of one field, and the account keeps everything else', async () => {
  // Control characters go the way they go everywhere else a field is accepted,
  // and the ends are trimmed, so what is stored is what will be drawn.
  const res = await read(await setDisplayName('  Coach Vera R  ', named.cookie))
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.user.displayName, 'Coach Vera R')
  assert.equal(res.body.user.email, named.email, 'the address was disturbed')
  assert.equal(res.body.user.isGuest, false)

  const me = await read(await call('/auth/me', {}, named.cookie))
  assert.equal(me.body.user.displayName, 'Coach Vera R')

  // And the room hears the new one on the next connection.
  const a = await openSocket(boardId, owner.cookie)
  const b = await openSocket(boardId, named.cookie)
  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.displayName, 'Coach Vera R')
  await Promise.all([closed(a), closed(b)])

  const back = await read(await setDisplayName('Coach Vera', named.cookie))
  assert.equal(back.status, 200, back.text)
})

test('nobody signed out can set a name', async () => {
  const res = await read(await setDisplayName('Nobody At All', null))
  assert.equal(res.status, 401, res.text)
})

test('signing up demands a display name', async () => {
  const without = await read(
    await call('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `nameless-${randomUUID()}@test.invalid`,
        password: 'Nameless!8814',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
      }),
    }),
  )
  assert.equal(without.status, 400, without.text)
  assert.equal(without.body.field, 'displayName')

  // Requiring it here is what makes every *new* account safe by construction,
  // so an address smuggled in as a name has to be refused here too.
  const asAddress = await read(
    await call('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `smuggled-${randomUUID()}@test.invalid`,
        password: 'Smuggled!8814',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
        displayName: 'coach@example.com',
      }),
    }),
  )
  assert.equal(asAddress.status, 400, asAddress.text)

  const address = `signed-up-${randomUUID()}@test.invalid`
  const ok = await read(
    await call('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: address,
        password: 'Signedup!8814',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
        displayName: 'Nia Adeyemi',
      }),
    }),
  )
  assert.equal(ok.status, 201, ok.text)
  assert.equal(ok.body.user.displayName, 'Nia Adeyemi')
  made.push(ok.body.user.id)
})

test('claiming a guest account demands a display name too', async () => {
  const guest = await admitGuest()

  const without = await read(
    await call('/auth/claim', {
      method: 'POST',
      body: JSON.stringify({
        email: `claimed-${randomUUID()}@test.invalid`,
        password: 'Claimed!8814',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
      }),
    }, guest.cookie),
  )
  assert.equal(without.status, 400, without.text)
  assert.equal(without.body.field, 'displayName')

  // Still a guest: a refused claim must not half-apply.
  const still = await read(await call('/auth/me', {}, guest.cookie))
  assert.equal(still.body.user.isGuest, true)

  const ok = await read(
    await call('/auth/claim', {
      method: 'POST',
      body: JSON.stringify({
        email: `claimed-${randomUUID()}@test.invalid`,
        password: 'Claimed!8814',
        acceptedTerms: true,
        securityQuestionId: 'first-pet',
        securityAnswer: 'Rex',
        displayName: 'Tomas Bloor',
      }),
    }, guest.cookie),
  )
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.body.user.displayName, 'Tomas Bloor')
  assert.equal(ok.body.user.isGuest, false)
})

test('a guest can choose a name, and the room uses it instead of an animal', async () => {
  // The case where this is strictly better than what was there: a guest has no
  // address, so before this the room could only call them Anonymous Something.
  const guest = await admitGuest()

  const set = await read(await setDisplayName('Touchline Tim', guest.cookie))
  assert.equal(set.status, 200, set.text)
  assert.equal(set.body.user.displayName, 'Touchline Tim')
  assert.equal(set.body.user.isGuest, true, 'naming yourself is not claiming the account')

  const a = await openSocket(boardId, owner.cookie)
  const b = await openSocket(boardId, guest.cookie)
  const joined = await waitForMessage(a, (m) => m.type === 'peer-joined')
  assert.equal(joined.displayName, 'Touchline Tim')
  assert.doesNotMatch(joined.displayName, ANONYMOUS_NAME)
  await Promise.all([closed(a), closed(b)])
})

test('the owner sees a name for every member, guests included', async () => {
  /**
   * The bug this fixes is not cosmetic in the way it looks. The member list
   * selected `u.email`, which is null for a guest, so the owner's own "who is on
   * my board" list drew a blank row with a Remove button beside it and no way to
   * tell one guest from another.
   *
   * The owner is entitled to a real address for anybody who has one — "who has
   * access to my board" is theirs to know — so the address is what they get, and
   * a name only stands in where there is no address to give.
   */
  const unnamed = await admitGuest()

  const list = await read(await call(`/boards/${boardId}/members`, {}, owner.cookie))
  assert.equal(list.status, 200, list.text)

  for (const member of list.body.members) {
    assert.ok(
      typeof member.displayName === 'string' && member.displayName.length > 0,
      `a member came back with nothing to draw: ${JSON.stringify(member)}`,
    )
  }

  const real = list.body.members.find((m) => m.id === plain.id)
  assert.equal(real.email, plain.email, 'the owner is entitled to the address')
  assert.equal(real.displayName, plain.email, 'and it is what the list draws for them')

  const guestRow = list.body.members.find((m) => m.id === unnamed.id)
  assert.equal(guestRow.email, null, 'a guest has no address to disclose')
  assert.match(guestRow.displayName, ANONYMOUS_NAME, 'so the list names them the way the room does')

  // And a guest who chose a name is called it here as well, which is the point
  // of there being one field to draw rather than two to choose between.
  await setDisplayName('Kit Room Kim', unnamed.cookie)
  const again = await read(await call(`/boards/${boardId}/members`, {}, owner.cookie))
  assert.equal(again.body.members.find((m) => m.id === unnamed.id).displayName, 'Kit Room Kim')
})

test('the stored name is what the room reads, not something a client sends', async () => {
  // Identity is stamped server-side. A client introducing itself under a name of
  // its choosing is the failure this whole substitution exists to prevent.
  const a = await openSocket(boardId, owner.cookie)
  const b = await openSocket(boardId, named.cookie)

  b.send(JSON.stringify({ type: 'here', displayName: 'The Owner', email: 'owner@example.com' }))
  const present = await waitForMessage(a, (m) => m.type === 'peer-present')
  assert.equal(present.displayName, 'Coach Vera')
  assert.equal(
    JSON.stringify(a.received).includes('@'),
    false,
    'a client talked an address into the room',
  )

  await Promise.all([closed(a), closed(b)])
})

test('a guest with no session cannot be renamed by somebody else', async () => {
  // The account is named by the cookie and never by the body, so there is no
  // shape of this request that renames another person.
  const guest = await admitGuest()
  const res = await read(
    await call(
      '/auth/display-name',
      {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Not Theirs', userId: guest.id }),
      },
      named.cookie,
    ),
  )
  assert.equal(res.status, 200, res.text)

  const theirs = await read(await call('/auth/me', {}, guest.cookie))
  assert.equal(theirs.body.user.displayName, null, 'somebody else was renamed')

  await setDisplayName('Coach Vera', named.cookie)
})
