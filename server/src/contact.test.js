import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { migrate, all, run, closePool } from './db.js'
import { decrypt, initEncryption } from './crypto.js'

/**
 * The contact form, which is the only route to a human in this product.
 *
 * It is the one endpoint here that writes to the database without a session,
 * and that is a requirement rather than an oversight: the privacy policy
 * promises a right of erasure, and the person most likely to need it is
 * somebody who already deleted their account. So what is worth asserting is
 * everything that stands in for the sign-in that is deliberately absent — the
 * validation, the caps, and the two limiters — plus the one thing the policy
 * page now claims in writing, which is that the message and the address are
 * encrypted at rest.
 */

const PORT = 8804
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

let child

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

/** A fresh address per case, because one of the two limiters is keyed on it. */
let n = 0
const addr = () => `contact-${Date.now()}-${n++}@test.invalid`

const send = (body) =>
  fetch(`http://127.0.0.1:${PORT}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const good = (over = {}) => ({
  topic: 'privacy',
  replyTo: addr(),
  body: 'Please delete the account tied to this address.',
  ...over,
})

const rowsFor = async (replyTo) =>
  (await all('SELECT topic, reply_to, body, created_at, handled_at FROM contact_messages')).filter(
    (r) => decrypt(r.reply_to) === replyTo,
  )

before(async () => {
  // The spawned server initialises its own; this process reads rows back and
  // decrypts them, so it needs the key too. Without it every assertion about
  // what was stored dies on "Encryption is not initialised" — which is how the
  // first run of this file failed, and is the sort of thing an unrun test file
  // hides indefinitely.
  initEncryption()
  await migrate()
  await run('DELETE FROM login_attempts WHERE key LIKE $1', 'contact:%')

  child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(PORT), APP_ENV: 'test' },
    stdio: 'inherit',
  })
  await waitForHealth()
})

after(async () => {
  child?.kill()
  await run('DELETE FROM login_attempts WHERE key LIKE $1', 'contact:%')
  await closePool()
})

test('takes a message from somebody with no account at all', async () => {
  const message = good()
  const res = await send(message)

  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { received: true })

  const rows = await rowsFor(message.replyTo)
  assert.equal(rows.length, 1, 'exactly one row was written')
  assert.equal(rows[0].topic, 'privacy')
  assert.equal(rows[0].handled_at, null, 'it arrives unhandled')
})

/**
 * The claim the privacy policy makes in so many words, so it is asserted rather
 * than trusted: these arrive carrying the personal data of people asking about
 * their personal data, and storing that beside encrypted boards in the clear
 * would be the wrong way round.
 */
test('stores the message and the address encrypted, and the topic in the clear', async () => {
  const message = good({ body: 'A sentence nobody should find by reading the table.' })
  await send(message)

  const [row] = await all(
    'SELECT topic, reply_to, body FROM contact_messages ORDER BY created_at DESC LIMIT 1',
  )
  assert.notEqual(row.body, message.body, 'the body is not sitting there in plaintext')
  assert.notEqual(row.reply_to, message.replyTo, 'nor is the address')
  assert.match(row.body, /^v1:/, 'both are sealed with the board cipher')
  assert.match(row.reply_to, /^v1:/)
  // And they come back, or the encryption is a way of losing messages.
  assert.equal(decrypt(row.body), message.body)
  assert.equal(decrypt(row.reply_to), message.replyTo)
  // Triage has to work without the key, which is the whole reason for this one.
  assert.equal(row.topic, 'privacy')
})

test('refuses a topic that is not one of the five', async () => {
  // A free-text subject is what this list replaced; `copyright` in particular
  // has to be a named channel the Terms can point at.
  const res = await send(good({ topic: 'anything-i-like' }))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).field, 'topic')
})

test('refuses a message with nowhere to reply to', async () => {
  for (const replyTo of ['', 'not-an-address', undefined]) {
    const res = await send(good({ replyTo }))
    assert.equal(res.status, 400, `"${replyTo}" was accepted`)
  }
})

test('refuses an empty message and a novel', async () => {
  const tooShort = await send(good({ body: 'hi' }))
  assert.equal(tooShort.status, 400)
  assert.equal((await tooShort.json()).field, 'body')

  const tooLong = await send(good({ body: 'x'.repeat(4001) }))
  assert.equal(tooLong.status, 400)
  assert.equal((await tooLong.json()).field, 'body')
})

test('writes nothing at all for a request it refused', async () => {
  const before = (await all('SELECT id FROM contact_messages')).length
  await send(good({ topic: 'nonsense' }))
  await send(good({ body: '' }))
  await send(good({ replyTo: 'nope' }))
  assert.equal((await all('SELECT id FROM contact_messages')).length, before)
})

/**
 * The limit that stands in for the sign-in. A public endpoint that writes to a
 * database is a public endpoint that fills a disk, and the cap has to be low
 * enough that a loop meets it in seconds and high enough that a real follow-up
 * never does.
 */
test('stops one address filling the table', async () => {
  const replyTo = addr()
  const statuses = []
  for (let i = 0; i < 7; i++) statuses.push((await send(good({ replyTo }))).status)

  // Five through and the sixth refused, which is `max: 6` — the shared limiter
  // locks *on* the `max`th call rather than after it, so the constant is one
  // more than the allowance. This assertion is the thing that pins that, and it
  // is what caught the route giving four when its comment claimed five.
  assert.deepEqual(statuses.slice(0, 5), [202, 202, 202, 202, 202], 'five get through')
  assert.equal(statuses[5], 429, 'the sixth does not')
  assert.equal(statuses[6], 429)
  assert.equal((await rowsFor(replyTo)).length, 5, 'and the refused ones wrote nothing')
})
