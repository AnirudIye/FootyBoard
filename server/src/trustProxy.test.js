import test from 'node:test'
import assert from 'node:assert/strict'
import { trustProxySetting } from './env.js'

/**
 * What `TRUST_PROXY` turns into before Express ever sees it.
 *
 * Two failures live here and they are not the same shape. The first is a crash:
 * Express hands any string it does not recognise to `proxy-addr`, which
 * compiles it as an IP list, so `'true'` used to throw `invalid IP address:
 * true` from a stack naming neither this variable nor the file that set it.
 *
 * The second is worse because nothing throws at all. `true` means "believe the
 * left-most `X-Forwarded-For` entry", which is the one the caller wrote, so
 * `req.ip` stops being an observation and becomes a request field — and every
 * per-IP allowance in `rateLimit.js` starts counting whichever bucket the
 * person being limited picked. Behind cloudflared the answer is always `1`.
 */

test('a hop count comes back as a number, because Express counts from the right', () => {
  assert.equal(trustProxySetting('1'), 1)
  assert.equal(trustProxySetting('2'), 2)
  assert.equal(trustProxySetting('0'), 0)
})

test('true is honoured off production, where a developer may mean it', () => {
  assert.equal(trustProxySetting('true', { production: false }), true)
  assert.equal(trustProxySetting('true', {}), true)
})

test('true is refused in production, and the error says what to set instead', () => {
  assert.throws(
    () => trustProxySetting('true', { production: true }),
    /TRUST_PROXY=1/,
    'production accepted the setting that lets a caller choose their own rate-limit bucket',
  )
})

test('false comes back as a boolean rather than the string Express would compile', () => {
  assert.equal(trustProxySetting('false', { production: true }), false)
})

test('the named and address forms are left for Express to compile', () => {
  assert.equal(trustProxySetting('loopback'), 'loopback')
  assert.equal(trustProxySetting('10.0.0.0/8'), '10.0.0.0/8')
  assert.equal(trustProxySetting('loopback, linklocal'), 'loopback, linklocal')
})

test('a number that is not a hop count is not treated as one', () => {
  // Negative and fractional counts are meaningless to `proxy-addr`, and
  // silently rounding them would be inventing a policy nobody wrote.
  assert.equal(trustProxySetting('-1'), '-1')
  assert.equal(trustProxySetting('1.5'), '1.5')
})
