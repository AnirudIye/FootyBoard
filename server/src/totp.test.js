import test from 'node:test'
import assert from 'node:assert/strict'
import {
  base32Encode,
  base32Decode,
  generateSecret,
  stepAt,
  codeForStep,
  matchStep,
  otpauthUri,
} from './totp.js'

/**
 * The TOTP primitives, against the vectors that make writing them defensible.
 *
 * Nothing here is a dependency, which is the decision this file exists to
 * justify rather than merely to exercise. HMAC-SHA1 over a big-endian counter
 * with RFC 4226's dynamic truncation is forty lines on `node:crypto`, and base32
 * is twenty more; the reason it is reasonable to write those by hand instead of
 * pulling in a package is that both are pinned by published test vectors, so a
 * hand-rolled implementation that is wrong cannot be quietly wrong. The numbers
 * below are copied from RFC 6238 Appendix B and RFC 4648 section 10, and they
 * are what stands between this and a factor nobody's phone agrees with.
 *
 * No port, no Postgres, no spawned instance. Every export here is a pure
 * function of its arguments, so a suite that spawned a server would be spending
 * a second of startup to test nothing extra. That is new for this repo's server
 * tests and it is correct exactly here and nowhere the tests touch a route.
 */

/** RFC 6238 Appendix B: the ASCII secret every SHA-1 vector in that table uses. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

test('the RFC 6238 Appendix B vectors, which is what makes a hand-written HMAC defensible', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')

  // Seconds since the epoch, and the six-digit code the RFC says that instant
  // produces. The RFC prints eight digits; six is what this product shows, and
  // truncating an eight-digit vector to its last six is exactly what a
  // DIGITS = 6 implementation computes, because the modulus is the last step.
  for (const [seconds, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]) {
    const step = stepAt(seconds * 1000)
    assert.equal(codeForStep(RFC_SECRET, step), expected, `T = ${seconds}`)
  }
})

test('base32 round trips the RFC 4648 vectors, and emits them without padding', () => {
  // The RFC's forms are padded. This module emits without padding, because an
  // `otpauth://` secret is typed by hand and `=` is noise at the end of a string
  // somebody is copying character by character.
  for (const [plain, padded] of [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ]) {
    const unpadded = padded.replace(/=+$/, '')
    assert.equal(base32Encode(Buffer.from(plain, 'ascii')), unpadded, `encoding ${plain}`)
    // And decoding tolerates the padded form anyway, since that is what the
    // rest of the world emits.
    assert.equal(base32Decode(padded).toString('ascii'), plain, `decoding ${padded}`)
    assert.equal(base32Decode(unpadded).toString('ascii'), plain, `decoding ${unpadded}`)
  }
})

test('decoding tolerates how people actually retype a secret', () => {
  // The enrollment page shows the secret in groups of four, so what comes back
  // has spaces in it, and somebody typing on a phone gets lowercase for free.
  const spaced = 'mzxw 6ytb oi'
  assert.equal(base32Decode(spaced).toString('ascii'), 'foobar')
  assert.equal(base32Decode('MZXW-6YTB-OI').toString('ascii'), 'foobar')
  assert.equal(base32Decode('  MZXW6YTBOI  ').toString('ascii'), 'foobar')
})

test('matchStep accepts one step either side and nothing further out', () => {
  // A fixed instant rather than the clock, so this cannot pass or fail on which
  // side of a thirty second boundary the suite happens to run.
  const now = 1_700_000_000_000
  const here = stepAt(now)

  for (const offset of [-1, 0, 1]) {
    const code = codeForStep(RFC_SECRET, here + offset)
    assert.equal(
      matchStep(RFC_SECRET, code, { now }),
      here + offset,
      `a code ${offset} steps away was refused`,
    )
  }

  // Two steps out is sixty seconds of clock skew, which RFC 6238 section 5.2
  // says not to allow: every extra step multiplies what a blind guess can hit.
  for (const offset of [-2, 2, -10, 10]) {
    assert.equal(
      matchStep(RFC_SECRET, codeForStep(RFC_SECRET, here + offset), { now }),
      null,
      `a code ${offset} steps away was accepted`,
    )
  }
})

test('matchStep answers null rather than throwing for anything that is not a code', () => {
  const now = 1_700_000_000_000
  for (const rubbish of ['', '12345', '1234567', 'abcdef', '12345a', '  123456  ', null, undefined, 123456, {}]) {
    assert.equal(matchStep(RFC_SECRET, rubbish, { now }), null, `${JSON.stringify(rubbish)} matched`)
  }
})

test('a generated secret is 32 base32 characters, and two of them differ', () => {
  const secret = generateSecret()
  assert.match(secret, /^[A-Z2-7]{32}$/)
  // Twenty random bytes, which is what RFC 4226 section 4 requires as a minimum
  // and what every authenticator expects to be handed.
  assert.equal(base32Decode(secret).length, 20)
  assert.notEqual(secret, generateSecret())
})

test('the otpauth URI names the account and the issuer, both escaped', () => {
  const uri = otpauthUri({ secret: RFC_SECRET, account: 'coach@example.com', issuer: 'FootyBoard' })

  assert.ok(uri.startsWith('otpauth://totp/'))
  // The label is `Issuer:account`, which is what puts the product name above the
  // code in the app rather than leaving a bare address in a list of them.
  assert.ok(uri.includes('FootyBoard:coach%40example.com'), uri)
  assert.ok(uri.includes(`secret=${RFC_SECRET}`), uri)
  assert.ok(uri.includes('issuer=FootyBoard'), uri)
  // The period and the digit count are written out here rather than imported
  // from the module, which is the opposite of the usual rule and is deliberate.
  // A test that imports the constant it is checking can never fail when that
  // constant changes, which is exactly the change worth failing on: every
  // enrolled authenticator in the world is holding these two numbers, so moving
  // one silently invalidates every existing factor.
  assert.ok(uri.includes('period=30'), uri)
  assert.ok(uri.includes('algorithm=SHA1'), uri)
  assert.ok(uri.includes('digits=6'), uri)
})
