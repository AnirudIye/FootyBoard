import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords, RFC 6238, on `node:crypto` alone.
 *
 * **Why this is written out rather than installed.** TOTP is HMAC over a
 * big-endian counter plus RFC 4226's dynamic truncation, and base32 is a
 * five-bit repacking of bytes. Together that is about sixty lines. The repo
 * calls Gemini with `fetch` rather than an SDK and runs Postgres without Docker,
 * so a package here would be out of character; what makes it *safe* as well as
 * consistent is that both algorithms are pinned by published test vectors.
 * `totp.test.js` asserts the RFC 6238 Appendix B table and the RFC 4648 section
 * 10 strings, so an implementation that is subtly wrong fails loudly instead of
 * shipping a factor that disagrees with everybody's phone.
 *
 * **SHA-1, and that is not an oversight.** RFC 6238 allows SHA-256 and SHA-512,
 * and essentially no authenticator app implements them for a QR or a typed
 * secret: choosing one would produce codes nothing on a phone can generate. The
 * weakness SHA-1 has is collision resistance, which HMAC does not rest on, and
 * the output here is six digits from a secret that is rotated by re-enrolling.
 *
 * Everything in this file is a pure function. The sealing, the storage and the
 * replay defence all live in `twoFactor.js`, so this file has no idea a database
 * exists and can be reasoned about entirely from its inputs.
 */

/**
 * The four numbers a factor is defined by. They never leave this file.
 *
 * Not exported, and that is a decision rather than an omission. Every enrolled
 * authenticator is holding a copy of the period and the digit count already, so
 * these are not parameters anybody may tune later: changing one invalidates
 * every factor in existence. Keeping them unexported means there is no call site
 * that could pass a different value, and the `otpauth://` URI below is the only
 * thing that tells anybody what they are.
 *
 * `WINDOW_STEPS` is one, per RFC 6238 section 5.2, so three codes are acceptable
 * at any instant and a blind guess lands with probability 3 x 10^-6. Widening it
 * multiplies that linearly and buys almost nothing, since phones sync over NTP.
 *
 * `SECRET_BYTES` is twenty, the minimum RFC 4226 section 4 requires, and it is
 * also what makes a secret exactly 32 base32 characters with no padding.
 */
const PERIOD_SECONDS = 30
const DIGITS = 6
const WINDOW_STEPS = 1
const SECRET_BYTES = 20

/** RFC 4648's base32 alphabet. Not the join code's, and not related to it. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Bytes to base32, without padding.
 *
 * The `=` the RFC appends carries no information: the decoder can tell how many
 * bytes it produced from the character count alone. Padding is dropped because
 * this string is displayed to somebody who is copying it into their phone by
 * hand, and trailing punctuation in a field like that is a source of mistakes
 * rather than a source of meaning. The `otpauth://` convention is unpadded too.
 */
export function base32Encode(bytes) {
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    // At most twelve bits are ever in flight here, so this stays well inside
    // what a 32-bit shift can hold.
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * base32 back to bytes, forgiving of how the string arrives.
 *
 * Case, spaces, hyphens and trailing padding are all stripped before decoding,
 * for the reason `normalizeCode` gives about join codes: the shape somebody
 * retypes a secret in is never the difference between enrolling and being told
 * their authenticator is wrong. The enrollment page shows the secret in groups
 * of four precisely so it can be read, so the spaces it introduces have to come
 * back off here.
 *
 * A character that is not in the alphabet throws rather than being skipped.
 * Every caller in this codebase passes a secret this module generated and the
 * database stored, so a bad character means the column is corrupt, and silently
 * decoding a shorter secret would turn that into a factor nobody can satisfy.
 */
export function base32Decode(text) {
  const cleaned = String(text).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  let value = 0
  let bits = 0
  const out = []
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index === -1) throw new Error(`"${character}" is not a base32 character.`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  // Whatever is left is the padding bits, which are zero by construction.
  return Buffer.from(out)
}

/** A fresh shared secret. `randomBytes`, because this is a credential. */
export const generateSecret = () => base32Encode(randomBytes(SECRET_BYTES))

/** Which thirty second step a moment falls in. Milliseconds in, step out. */
export const stepAt = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / PERIOD_SECONDS)

/**
 * The code a given step produces, which is the whole of RFC 4226.
 *
 * The counter is the step as a big-endian eight byte integer, HMAC'd under the
 * secret; the last nibble of the digest picks where to read four bytes from, the
 * top bit of those is masked off so the value is positive on every platform, and
 * the six digits are that value modulo a million, left-padded. The padding is
 * load-bearing: a code of 5,924 is `005924`, and a `Number` that dropped the
 * leading zeros would fail one in ten attempts.
 */
export function codeForStep(secretBase32, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))

  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)

  return String(truncated % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * Which step a submitted code belongs to, or null.
 *
 * **A step number rather than a boolean, and that is what makes replay
 * defence possible at all.** A code is valid for ninety seconds, so somebody who
 * reads one over a shoulder or off a phished form has a real window to use it
 * again; `twoFactor.js` closes that by claiming the step in a single UPDATE, and
 * it cannot claim a step a boolean never told it.
 *
 * **Every candidate is evaluated, and the loop does not break on a hit.**
 * Returning early would make the response time say which of the three steps
 * matched, which is a small leak about the clock the caller is running on, and
 * the cost of not doing it is two extra HMACs. `timingSafeEqual` over equal
 * length buffers is what compares them, so the digits themselves do not leak
 * through timing either.
 *
 * Anything that is not six digits is null rather than a throw. This is reached
 * with whatever a stranger put in a form field, and a 500 on a malformed body
 * would be both a worse message and a way to tell a real account from a decoy.
 */
export function matchStep(secretBase32, code, { now = Date.now(), window = WINDOW_STEPS } = {}) {
  if (typeof code !== 'string' || code.length !== DIGITS || !/^[0-9]+$/.test(code)) return null

  const submitted = Buffer.from(code, 'ascii')
  const here = stepAt(now)
  let matched = null

  for (let offset = -window; offset <= window; offset++) {
    const step = here + offset
    if (timingSafeEqual(Buffer.from(codeForStep(secretBase32, step), 'ascii'), submitted)) {
      matched = step
    }
  }
  return matched
}

/**
 * The `otpauth://` URI an authenticator app consumes.
 *
 * The label is `Issuer:account` and the issuer is repeated as a parameter,
 * which is what the de facto spec asks for and what makes the app show the
 * product name above the code rather than a bare address in a list of them. The
 * issuer arrives as an argument rather than being a constant here, because the
 * product name is `twoFactor.js`'s to know: this file is the algorithm and
 * nothing about the product.
 *
 * The three parameters that restate the defaults are sent deliberately. They are
 * the defaults for every app worth using, and an app that guessed differently
 * would produce codes this server rejects with no way to tell why.
 */
export function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}
