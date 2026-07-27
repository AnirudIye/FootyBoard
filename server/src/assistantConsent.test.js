import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate, run, get, closePool } from './db.js'
import { createSession, COOKIE_NAME } from './auth.js'

/**
 * Consent for the online assistant, enforced by the server.
 *
 * The panel asks first, but that is the browser promising on the server's
 * behalf: this endpoint is an ordinary authenticated POST, and the answer it
 * was relying on lives in `localStorage` on a machine the server never sees. So
 * the request has to carry the flag, its absence has to be a refusal, and the
 * grant has to be written down somewhere that survives clearing site data.
 *
 * Neither path here reaches Google. Without consent nothing is sent at all, and
 * with it the request is turned back by message validation first, which is
 * deliberate: the assertion is about the record, not about the provider.
 */

const PORT = 8801
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child
let user

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

const ask = (body) =>
  fetch(`http://127.0.0.1:${PORT}/api/assistant`, {
    method: 'POST',
    headers: { Cookie: user.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const consentRow = () =>
  get('SELECT user_id FROM assistant_consents WHERE user_id = $1', user.id)

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

  // A key only has to be present, not valid: the route answers 503 without one,
  // and nothing below gets far enough to spend it.
  child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `test-${PORT}`,
      GEMINI_API_KEY: 'not-a-real-key',
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
  await run('DELETE FROM users WHERE id = $1', user.id)
  await closePool()
})

test('a request with no consent is refused, and records nothing', async () => {
  const res = await ask({ message: 'press them high' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).field, 'consent')
  assert.equal(await consentRow(), null, 'nothing is recorded for a request that was refused')
})

test('consent has to be the boolean true, not merely truthy', async () => {
  for (const consent of [false, 'yes', 1, null]) {
    const res = await ask({ message: 'press them high', consent })
    assert.equal(res.status, 400, `consent: ${JSON.stringify(consent)} was accepted`)
  }
  assert.equal(await consentRow(), null)
})

test('consenting is recorded once, and survives the browser forgetting it', async () => {
  // Turned back by message validation rather than sent on, which is the point:
  // the grant is recorded because it was given, not because a reply came back.
  const res = await ask({ message: '', consent: true })
  assert.equal(res.status, 400)

  const first = await get(
    'SELECT granted_at FROM assistant_consents WHERE user_id = $1',
    user.id,
  )
  assert.ok(first, 'the grant is on the server, not only in localStorage')

  await ask({ message: '', consent: true })
  const again = await get(
    'SELECT granted_at FROM assistant_consents WHERE user_id = $1',
    user.id,
  )
  assert.equal(again.granted_at, first.granted_at, 'the first grant is the one kept')
})

test('deleting the account takes the consent record with it', async () => {
  await run('DELETE FROM users WHERE id = $1', user.id)
  assert.equal(await consentRow(), null)

  // Put the row back so `after` has something to delete and the session used by
  // the tests above is not left dangling.
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, 'x', 'x', $3, $3)`,
    user.id,
    `${user.id}@test.invalid`,
    new Date().toISOString(),
  )
})
