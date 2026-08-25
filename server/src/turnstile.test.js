import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { assertHuman, enabled, siteKey, TurnstileFailed, TOKEN_FIELD } from './turnstile.js'

/**
 * The verification call, with `fetch` stubbed.
 *
 * No network: what is being tested is the decision this module makes about a
 * response, not Cloudflare's ability to send one. The one shape worth spelling
 * out is that a *failure to reach* Cloudflare refuses the request rather than
 * waving it through, because that is the property an attacker would attack.
 */

const realFetch = globalThis.fetch
const SECRET = 'TURNSTILE_SECRET_KEY'
const SITE = 'TURNSTILE_SITE_KEY'

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env[SECRET]
  delete process.env[SITE]
})

/** Answer the next siteverify call with this JSON. */
const answering = (body, { ok = true } = {}) => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok, status: ok ? 200 : 500, json: async () => body }
  }
  return calls
}

test('unset, it does nothing and no request is made', async () => {
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('should not have been called')
  }
  assert.equal(enabled(), false)
  await assertHuman(undefined)
  await assertHuman('anything')
  assert.equal(called, false, 'an unconfigured deployment called Cloudflare')
})

test('the secret decides, not the sitekey', () => {
  process.env[SITE] = '1x00000000000000000000AA'
  assert.equal(enabled(), false, 'a sitekey alone rendered a widget nobody checks')
  assert.equal(siteKey(), '1x00000000000000000000AA')

  process.env[SECRET] = '1x0000000000000000000000000000000AA'
  assert.equal(enabled(), true)
})

test('a good token passes, and the secret is what is sent', async () => {
  process.env[SECRET] = '1x0000000000000000000000000000000AA'
  const calls = answering({ success: true })

  await assertHuman('XXXX.DUMMY.TOKEN.XXXX')

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify$/)
  assert.equal(calls[0].body.secret, '1x0000000000000000000000000000000AA')
  assert.equal(calls[0].body.response, 'XXXX.DUMMY.TOKEN.XXXX')
})

test('the client IP is not handed to Cloudflare', async () => {
  // `req.clientIp` is a /64 prefix once limiterIp has masked it, so it is not
  // an address anyone can be asked about. remoteip is optional; it is omitted.
  process.env[SECRET] = 'x'
  const calls = answering({ success: true })
  await assertHuman('t')
  assert.equal('remoteip' in calls[0].body, false)
})

test('a missing token is refused without asking Cloudflare', async () => {
  process.env[SECRET] = 'x'
  let called = false
  globalThis.fetch = async () => {
    called = true
    return { ok: true, json: async () => ({ success: true }) }
  }

  await assert.rejects(() => assertHuman(undefined), TurnstileFailed)
  await assert.rejects(() => assertHuman(''), TurnstileFailed)
  assert.equal(called, false, 'an empty token still cost a round trip')
})

test('a refused token is refused, and says nothing about why', async () => {
  process.env[SECRET] = 'x'
  answering({ success: false, 'error-codes': ['invalid-input-response'] })

  await assert.rejects(
    () => assertHuman('forged'),
    (err) => {
      assert.ok(err instanceof TurnstileFailed)
      assert.equal(err.message, 'Verification failed. Try again.')
      assert.equal(err.field, TOKEN_FIELD)
      return true
    },
  )
})

test('a spent token is named differently, because retrying fixes it', async () => {
  process.env[SECRET] = 'x'
  answering({ success: false, 'error-codes': ['timeout-or-duplicate'] })

  await assert.rejects(
    () => assertHuman('already-used'),
    (err) => {
      assert.match(err.message, /expired/i)
      assert.deepEqual(err.codes, ['timeout-or-duplicate'])
      return true
    },
  )
})

test('an unreachable Cloudflare refuses the request rather than waving it through', async () => {
  process.env[SECRET] = 'x'
  globalThis.fetch = async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  }

  await assert.rejects(
    () => assertHuman('good-token'),
    (err) => {
      assert.ok(err instanceof TurnstileFailed, 'a timeout became a pass')
      assert.deepEqual(err.codes, ['siteverify-unreachable'])
      return true
    },
  )
})

test('a 5xx from siteverify also refuses', async () => {
  process.env[SECRET] = 'x'
  answering({}, { ok: false })

  await assert.rejects(
    () => assertHuman('good-token'),
    (err) => {
      assert.deepEqual(err.codes, ['siteverify-unavailable'])
      return true
    },
  )
})

test('the failure carries a 400 so the error handler answers the client', async () => {
  process.env[SECRET] = 'x'
  answering({ success: false, 'error-codes': ['invalid-input-response'] })
  await assert.rejects(() => assertHuman('x'), (err) => err.status === 400)
})
