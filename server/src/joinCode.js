import { randomInt } from 'node:crypto'

/**
 * Short join codes.
 *
 * The link is a credential you send someone. The code is a thing you read out
 * to a room, or leave on screen while people type it in — a completely
 * different constraint: it has to survive being transcribed by someone reading
 * it from across a hall.
 *
 * So: letters only, and no `I` or `O`. Mixing letters and digits is what
 * creates the pairs people actually get wrong — `S`/`5`, `B`/`8`, `Z`/`2`,
 * `G`/`6` — and dropping digits altogether removes all of them at once. `I` and
 * `O` go too, because people read them as `1` and `0` even when there are no
 * digits to confuse them with.
 *
 * Twenty-four letters over six places is about 191 million combinations. That
 * is nowhere near a 32-byte token and is not meant to be: what protects a join
 * code is the rate limit on redeeming it, not its length. A code also only ever
 * grants membership — the owner can see who joined, remove them, lock editing,
 * and revoke the code outright.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 6

/**
 * How long a code stays usable.
 *
 * Twelve hours covers a training session, a team meeting, or a school day
 * without anyone having to think about it, and is short enough that a code
 * written on a whiteboard on Monday is not still letting people in on Friday.
 *
 * Expiry is not only tidiness: it is the main thing keeping the guessable space
 * small. A blind guess has to hit one of the codes that are live *right now*,
 * so codes ageing out continuously shrinks what an attacker is aiming at. The
 * link, being a full-length token, has no expiry and does not need one.
 */
export const CODE_TTL_MS = 12 * 60 * 60 * 1000

export const codeExpiryFrom = () => Date.now() + CODE_TTL_MS

/** `randomInt`, not `Math.random`: this is a credential, however short. */
export function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

/**
 * Runs `write` with a fresh code, once more if the unique index rejects it.
 *
 * The index on live shares is the arbiter of uniqueness, not a check-then-write
 * that would race. A collision needs two of a handful of live shares to draw
 * the same one of 191 million codes, so this is not a loop that expects to go
 * round; it is here because the alternative — letting 23505 out — is a 500 on
 * one request from the routes, and a failed migration on every booting instance
 * from the backfill, in exchange for saving three lines.
 */
export async function withFreshCode(write) {
  for (let attempt = 0; ; attempt++) {
    const code = generateCode()
    try {
      await write(code)
      return code
    } catch (err) {
      if (err.code !== '23505' || attempt > 0) throw err
    }
  }
}

/**
 * What someone typed, turned into what we stored — or null if it cannot be.
 *
 * Case and the spaces or hyphens people insert while reading a code aloud are
 * never the difference between joining and being told the code is wrong. `0`
 * and `1` are the one substitution worth guessing at: they are not in the
 * alphabet, so anyone who typed one was reading an `O` or an `I`, which are not
 * in it either — meaning the intended character is genuinely ambiguous and the
 * code is rejected rather than silently turned into a different board's.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null

  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '')
  if (cleaned.length !== CODE_LENGTH) return null
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null
  return cleaned
}
