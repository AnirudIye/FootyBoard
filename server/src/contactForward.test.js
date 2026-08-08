import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { emailFor, forwardingEnabled, forwardContactMessage } from './contactForward.js'

/**
 * Forwarding a contact message to a mailbox.
 *
 * The property under test throughout is that this **cannot cost a message**. The
 * row is written by the route before any of this runs, so every failure here is
 * a copy that did not arrive; if any of it could throw, a mail provider having a
 * bad afternoon would turn somebody's erasure request into a 500 and they would
 * be told to try again later. So every case below ends in a boolean, and none of
 * them ends in an exception.
 *
 * `fetch` is stubbed rather than a server being stood up: what is worth pinning
 * is the request this builds and the fact that nothing it can receive gets out
 * as a throw. `contact.test.js` covers the route, and covers it with forwarding
 * off — which is the shipped default and the case where the row is the whole
 * mechanism.
 */

const MESSAGE = {
  topic: 'privacy',
  replyTo: 'coach@example.test',
  body: 'Please delete the board I made on Tuesday, and everything attached to it.',
  receivedAt: Date.parse('2026-08-08T12:00:00.000Z'),
}

const realFetch = globalThis.fetch
const saved = {}
const KEYS = ['RESEND_API_KEY', 'CONTACT_FORWARD_TO', 'CONTACT_FORWARD_FROM']

/** Configure the feature, and record what `fetch` was handed. */
function configure({ key = 'test-key', to = 'operator@example.test', from } = {}) {
  process.env.RESEND_API_KEY = key
  process.env.CONTACT_FORWARD_TO = to
  if (from) process.env.CONTACT_FORWARD_FROM = from
}

const stubFetch = (impl) => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  return calls
}

const ok = () => ({ ok: true, status: 200 })

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('it is off unless both the key and the address are set', async () => {
  // Off is the shipped default, and it has to be the *quiet* default: the route
  // behaves exactly as it did before this existed, which is what makes the
  // feature safe to deploy ahead of the account being created.
  const calls = stubFetch(ok)

  assert.equal(forwardingEnabled(), false)
  assert.equal(await forwardContactMessage(MESSAGE), false)

  process.env.RESEND_API_KEY = 'test-key'
  assert.equal(forwardingEnabled(), false, 'a key with nowhere to send is not configured')
  assert.equal(await forwardContactMessage(MESSAGE), false)

  delete process.env.RESEND_API_KEY
  process.env.CONTACT_FORWARD_TO = 'operator@example.test'
  assert.equal(forwardingEnabled(), false, 'an address with no key is not configured')
  assert.equal(await forwardContactMessage(MESSAGE), false)

  assert.equal(calls.length, 0, 'an unconfigured forwarder still called out')
})

test('the email carries the message, and replies go to the person who wrote it', () => {
  configure()
  const mail = emailFor(MESSAGE)

  assert.deepEqual(mail.to, ['operator@example.test'])
  // The whole point of the feature: answering is a reply rather than a
  // copy-paste out of a decrypted database row.
  assert.equal(mail.reply_to, 'coach@example.test')
  assert.equal(mail.subject, 'FootyBoard contact: privacy')
  assert.match(mail.text, /Please delete the board I made on Tuesday/)
  assert.match(mail.text, /coach@example\.test/)
  assert.match(mail.text, /2026-08-08T12:00:00\.000Z/)
  // The default sender needs no domain verification, which is what makes this
  // work on the day the key is pasted in rather than after a DNS round trip.
  assert.equal(mail.from, 'onboarding@resend.dev')
})

test('a verified sender can be set without changing where replies go', () => {
  configure({ from: 'contact@footyboard.me' })
  const mail = emailFor(MESSAGE)

  assert.equal(mail.from, 'contact@footyboard.me')
  assert.equal(mail.reply_to, 'coach@example.test')
})

test('it posts to Resend with the key in the header, not the body', async () => {
  configure()
  const calls = stubFetch(ok)

  assert.equal(await forwardContactMessage(MESSAGE), true)
  assert.equal(calls.length, 1)

  const { url, init } = calls[0]
  assert.equal(url, 'https://api.resend.com/emails')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer test-key')
  // A credential in a query string reaches logs and referrers; this one does not.
  assert.doesNotMatch(url, /test-key/)
  assert.doesNotMatch(init.body, /test-key/)

  const sent = JSON.parse(init.body)
  assert.deepEqual(sent.to, ['operator@example.test'])
  assert.equal(sent.reply_to, 'coach@example.test')
})

test('the key is not sent with surrounding whitespace', async () => {
  // A key pasted into a .env file arrives with a newline more often than not.
  configure({ key: '  test-key\n' })
  const calls = stubFetch(ok)

  await forwardContactMessage(MESSAGE)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key')
})

test('a provider that refuses the message is a false, never a throw', async () => {
  configure()
  stubFetch(() => ({ ok: false, status: 422 }))

  // The assertion is the absence of a rejection. A throw here reaches the route,
  // and the route is answering somebody whose message is already stored.
  assert.equal(await forwardContactMessage(MESSAGE), false)
})

test('a provider that is unreachable is a false, never a throw', async () => {
  configure()
  stubFetch(() => {
    throw new TypeError('fetch failed')
  })

  assert.equal(await forwardContactMessage(MESSAGE), false)
})

test('a provider that never answers is a false, never a hang', async () => {
  configure()
  // What `AbortSignal.timeout` is for: this runs inside the request, so a
  // provider that accepts the connection and then stops talking would hold the
  // response open for as long as it liked.
  stubFetch(() => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    throw err
  })

  assert.equal(await forwardContactMessage(MESSAGE), false)
})
