import { randomBytes, randomUUID, randomInt } from 'node:crypto'
import { get, run, transaction } from './db.js'
import { encrypt, decrypt } from './crypto.js'
import { tokenDigest } from './auth.js'
import { generateSecret, matchStep, otpauthUri } from './totp.js'

/**
 * The second factor: what is stored, what is claimed, and what is handed back.
 *
 * `totp.js` is the algorithm and knows nothing about a database. This file is
 * everything else: sealing the secret, the ten recovery codes, the short-lived
 * challenge that stands between "password accepted" and "code accepted", and
 * the two single-use claims that stop a code being spent twice.
 *
 * **The rule the whole file is built around: `totp_confirmed_at` is the switch,
 * never `totp_secret`.** A secret with a NULL `totp_confirmed_at` is an
 * enrollment somebody started and did not finish, and treating it as "2FA is on"
 * would turn an abandoned enrollment into a lockout. It is the same distinction
 * `is_guest` draws in `db.js`: a stored fact about how the account got here
 * beats an inference from what it currently holds.
 *
 * **Single use is enforced by the database in every case here**, in the shape
 * `consumeResetToken` established: the claim *is* the check. Reading a row and
 * then deciding in JavaScript leaves a window in which two requests carrying the
 * same credential both pass, and for a second factor that window is the feature.
 */

/**
 * Sixteen characters from a 24 letter alphabet, ten of them.
 *
 * **Sixteen is the number, and shortening it to make a page tidier is not a
 * cosmetic change.** 24^16 is about 2^72.7, so at an implausible 10^12 SHA-256
 * guesses a second against a stolen database one code takes on the order of
 * 100,000 years. Twelve characters would be about 2^55, which is not enough,
 * and it is the length rather than the hash that is carrying that.
 *
 * **Ten**, because it is enough to survive losing a phone and re-enrolling a
 * couple of times, and few enough that the page showing them is one screen.
 */
export const RECOVERY_CODE_COUNT = 10
export const RECOVERY_CODE_LENGTH = 16

/**
 * Twenty-four letters, no `I` and no `O`.
 *
 * **This is deliberately not imported from `joinCode.js`, whose `ALPHABET` is
 * character for character the same string.** They are two independent choices
 * that happen to agree, not one fact written twice. A join code is read aloud
 * across a hall and expires in twelve hours; a recovery code is written down,
 * kept in a drawer, and lasts until it is spent. The direction that costs
 * something is a *narrowing*: drop a letter from the join alphabet because it
 * turned out to be misread across a hall, and an import would have
 * `normalizeRecoveryCode` refuse every code in a drawer that contains it, which
 * is a lockout rather than a cosmetic change. Widening the join alphabet would
 * be harmless, and that is not a reason to share the string — only one of these
 * two has paper depending on it. This is the `INKS` precedent from `handoff.md`
 * rather than the team-colour one. `joinCode.js` carries the matching note.
 */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * How long the gap between the two halves of a sign-in may be.
 *
 * Five minutes is long enough to unlock a phone and open an app, and short
 * enough that a challenge left in a closed tab is worth nothing. The minutes
 * form is what goes to the client, so the page can say how long it has without
 * the number being written down a second time on that side.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const CHALLENGE_TTL_MINUTES = CHALLENGE_TTL_MS / 60000

/**
 * The label an authenticator app shows above the code.
 *
 * The second occurrence of the product name under `server/src`; the first is a
 * sentence in the assistant's system prompt. They are not the same fact and must
 * not become a shared constant: renaming everybody's authenticator entry as a
 * side effect of editing a prompt would be absurd, and the app keys its entry on
 * this string.
 */
const ISSUER = 'FootyBoard'

/** `ABCD-EFGH-JKLM-NPQR`, which is how a sixteen character code is readable. */
const formatRecoveryCode = (plain) => plain.match(/.{1,4}/g).join('-')

/**
 * What somebody typed, turned into what was stored, or null.
 *
 * Case, spaces and hyphens are stripped for the reason `normalizeCode` gives
 * about join codes: the shape a code is retyped in is never the difference
 * between getting back into an account and being locked out of it. `0` and `1`
 * are not silently read as `O` and `I`, because neither of those is in the
 * alphabet either, so the intended character is genuinely ambiguous.
 */
export function normalizeRecoveryCode(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '')
  if (cleaned.length !== RECOVERY_CODE_LENGTH) return null
  for (const character of cleaned) if (!RECOVERY_ALPHABET.includes(character)) return null
  return cleaned
}

/** `randomInt`, not `Math.random`: every one of these is a way into an account. */
function makeRecoveryCode() {
  let code = ''
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
  }
  return code
}

/**
 * Replace this account's recovery codes with ten fresh ones, on a client that
 * is already inside a transaction.
 *
 * Written once because both callers need exactly the same thing to be true
 * afterwards, and because "delete the old ones" is the half that would be easy
 * to leave out of the second copy: a regeneration that added ten without
 * removing the previous ten would double the number of ways into the account
 * every time somebody pressed the button.
 *
 * Stored as SHA-256 through `tokenDigest` rather than scrypt, and that follows
 * the line this repo already draws consistently: human-chosen secrets go through
 * the scrypt helper in `auth.js`, machine-generated high-entropy tokens are
 * stored as SHA-256 (`sessions`, `password_resets`, `board_shares`). scrypt
 * exists to make
 * grinding a *guessable* secret expensive, and 2^72.7 of `randomInt` is not
 * guessable in that sense. It also keeps the check one indexed read, which is
 * what lets `UPDATE ... WHERE used_at IS NULL` be the whole single-use
 * mechanism instead of ten scrypt derivations per attempt.
 */
async function replaceRecoveryCodes(client, userId, codes) {
  await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId])
  const now = new Date().toISOString()
  for (const code of codes) {
    await client.query(
      'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES ($1, $2, $3, $4)',
      [randomUUID(), userId, tokenDigest(code), now],
    )
  }
}

const freshCodes = () => Array.from({ length: RECOVERY_CODE_COUNT }, makeRecoveryCode)

/**
 * Start an enrollment: write a sealed, unconfirmed secret and describe it.
 *
 * Replaces any previous unconfirmed secret, so somebody who abandoned an
 * enrollment and came back gets a clean one rather than being asked for a code
 * from an app entry they deleted. It cannot replace a *confirmed* one, because
 * the route refuses when `totp_confirmed_at` is set and the statement below says
 * so again in its WHERE: this is the only place a secret is written and it must
 * never be able to overwrite a live factor, which would be a lockout.
 *
 * **Sealed rather than hashed, and that is forced rather than chosen.** The
 * server has to recompute the same HMAC the phone computes, so the secret has to
 * come back in plaintext; the scrypt helper the password and the security answer
 * both go through is structurally unavailable here in a way it is not for
 * either of them. (Its name is deliberately not written out anywhere in this
 * file, so that grepping this file for it stays a real check on "nothing here
 * hashes the secret" rather than a search that finds its own warning.)
 * `encrypt()` is what is
 * available instead, and it is the same function and the same key story board
 * contents already use. Two costs, neither of them hidden: in development and
 * test the key is derived from `SESSION_SECRET`, so this is worth about nothing
 * there; and a stolen database plus a stolen `ENCRYPTION_KEY` yields working
 * factors, which is inherent to TOTP and is why the recovery codes are hashed
 * and why the factor is not the account's only lock.
 */
export async function beginEnrollment(userId, account) {
  const secret = generateSecret()

  const written = await run(
    `UPDATE users SET totp_secret = $1, totp_last_step = NULL
      WHERE id = $2 AND totp_confirmed_at IS NULL`,
    encrypt(secret),
    userId,
  )
  if (written.changes === 0) return null

  return { secret, uri: otpauthUri({ secret, account, issuer: ISSUER }) }
}

/**
 * Finish an enrollment: prove the app is generating the right codes, and only
 * then turn the factor on.
 *
 * **This is the only statement anywhere that writes `totp_confirmed_at`**, which
 * is what prevents the failure this design exists to prevent: enrolling a secret
 * nobody can produce a code from, which is a locked account rather than a
 * nuisance.
 *
 * **The switch and the ten codes are one transaction, so mandatory recovery
 * codes are structural rather than a checkbox.** There is no ordering of these
 * statements that leaves an account with the factor on and no way back in if the
 * phone is lost.
 *
 * `totp_confirmed_at IS NULL` in the WHERE is what makes this safe against two
 * confirmations racing: without it both could read an unconfirmed row and both
 * insert ten codes, leaving twenty. `rowCount` is the answer, not a prior read.
 *
 * The confirming step is banked in `totp_last_step` in the same statement, so
 * the code somebody just typed here cannot be turned around and spent at
 * `/login/2fa` in the seconds it is still live.
 */
export async function confirmEnrollment(userId, code) {
  const row = await get('SELECT totp_secret, totp_confirmed_at FROM users WHERE id = $1', userId)
  if (!row?.totp_secret || row.totp_confirmed_at) return null

  const step = matchStep(decrypt(row.totp_secret), normalizeTotp(code))
  if (step === null) return null

  const codes = freshCodes()
  const confirmed = await transaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE users SET totp_confirmed_at = $1, totp_last_step = $2
        WHERE id = $3 AND totp_confirmed_at IS NULL`,
      [new Date().toISOString(), step, userId],
    )
    if (rowCount === 0) return false
    await replaceRecoveryCodes(client, userId, codes)
    return true
  })

  // Shown exactly once, here, and never again by any endpoint. That is the
  // `board_shares` rule and it has the same failure mode if it is relaxed.
  return confirmed ? codes.map(formatRecoveryCode) : null
}

/** Spaces and hyphens off a submitted TOTP code; people type them in threes. */
const normalizeTotp = (raw) => (typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : raw)

/**
 * Whether this submission satisfies the account's live factor. One field takes
 * both a TOTP code and a recovery code, and the shapes are unambiguous: six
 * digits or sixteen letters.
 *
 * **It reads `totp_confirmed_at`, so an unconfirmed enrollment is not a
 * factor.** Anything that read `totp_secret` instead would let somebody who had
 * seen an abandoned enrollment's secret through.
 *
 * **Both branches claim rather than check.**
 *
 * The TOTP branch moves `totp_last_step` forward in one statement guarded on
 * the step being new. Accepting a code twice inside its ninety seconds is a real
 * attack rather than a tidiness concern: somebody who reads a code over a
 * shoulder, or lifts one off a phished form, has that long to use it. Because
 * the claim is the check, two requests carrying the same code cannot both pass a
 * read and then both mint a session. `rowCount === 0` means the step is already
 * spent, and it is refused in exactly the words a wrong code is.
 *
 * The recovery branch moves `used_at` off NULL, which is the same mechanism from
 * the other direction and needs no clock at all.
 *
 * No rate limiting here. That is `rateLimit.js`'s `assertMayUseFactor` /
 * `recordFactorFailure` pair, called by the routes, because the read has to
 * happen *before* this function is reached: a limiter that only charged the
 * failure path, with nothing reading in front of it, would refuse the wrong
 * guesses and wave the right one through.
 */
export async function verifyFactor(userId, submitted) {
  const row = await get('SELECT totp_secret, totp_confirmed_at FROM users WHERE id = $1', userId)
  if (!row?.totp_secret || !row.totp_confirmed_at) return false

  const step = matchStep(decrypt(row.totp_secret), normalizeTotp(submitted))
  if (step !== null) {
    const claimed = await run(
      `UPDATE users SET totp_last_step = $1
        WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1)`,
      step,
      userId,
    )
    return claimed.changes === 1
  }

  const recovery = normalizeRecoveryCode(submitted)
  if (!recovery) return false

  const spent = await run(
    `UPDATE recovery_codes SET used_at = $1
      WHERE user_id = $2 AND code_hash = $3 AND used_at IS NULL`,
    Date.now(),
    userId,
    tokenDigest(recovery),
  )
  return spent.changes === 1
}

/** How many ways back in remain if the authenticator is lost. */
export async function remainingRecoveryCodes(userId) {
  const row = await get(
    'SELECT COUNT(*)::int AS remaining FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    userId,
  )
  return row?.remaining ?? 0
}

/** A fresh set of ten, replacing whatever was there. Requires a live factor at the route. */
export async function regenerateRecoveryCodes(userId) {
  const codes = freshCodes()
  await transaction((client) => replaceRecoveryCodes(client, userId, codes))
  return codes.map(formatRecoveryCode)
}

/**
 * Turn the factor off and leave nothing behind that could still open a door.
 *
 * One transaction, because a partial version of this is worse than either
 * outcome: the columns cleared but the codes left would mean ten strings still
 * open `/login/2fa` for an account the owner believes has no second factor at
 * all, and a pending challenge outliving the factor it was issued against is a
 * token nothing checks any more.
 *
 * **Sessions are deliberately not destroyed.** `/password` and `/reset` destroy
 * them because a credential *changed* in a way that might be locking an intruder
 * out; nothing about a live session's authority changes here, and the person has
 * just proved both factors. `/sessions` is one link away for anybody who wants
 * it. This is the decision in this feature most worth a second opinion, and it
 * is asserted positively in `twoFactorEnroll.test.js` so that reversing it is a
 * deliberate edit to a test rather than a surprise.
 */
export function disableTwoFactor(userId) {
  return transaction(async (client) => {
    await client.query(
      `UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL
        WHERE id = $1`,
      [userId],
    )
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId])
    await client.query('DELETE FROM auth_challenges WHERE user_id = $1 AND used_at IS NULL', [
      userId,
    ])
  })
}

/**
 * The thing that exists between "password accepted" and "code accepted".
 *
 * **A row, not a signed token and not a cookie.** A row because nothing durable
 * here lives in process memory: `npm run cluster` forks N instances behind a
 * round-robin balancer, so the instance that checks the code is almost never the
 * one that checked the password. It also has to be revocable, which a signed
 * token would not be, because `/2fa/disable` has to be able to void one.
 *
 * **Never a cookie**, and that is the load-bearing half. A cookie would ride on
 * every request to the API, including the board routes, which is exactly what
 * "this is not a session" has to avoid: one handler that forgets to distinguish
 * the two is an authentication bypass. In the response body it exists only in
 * the JavaScript memory of the page asking for the code. The cost, said plainly:
 * reload the page mid-challenge and you sign in again, which is correct for a
 * five minute step.
 */
export async function createChallenge(userId, purpose) {
  const token = randomBytes(32).toString('base64url')
  await run(
    `INSERT INTO auth_challenges (id, user_id, token_hash, purpose, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    randomUUID(),
    userId,
    tokenDigest(token),
    purpose,
    Date.now() + CHALLENGE_TTL_MS,
    new Date().toISOString(),
  )
  return token
}

/**
 * Spend a challenge, or answer null. The account is named by this row and never
 * by the request body, which is the property `/sessions` states about its cookie.
 *
 * `purpose` is compared here rather than trusted from the caller's intent: a
 * challenge issued by the recovery flow must not be spendable at `/login/2fa`
 * and the reverse, or one factor check would be met once and reused to buy a
 * different privilege.
 *
 * The claim is the check, in the shape `consumeResetToken` set. One message for
 * every failure mode, so the endpoint cannot distinguish a token that never
 * existed from one already spent, expired, or issued for the other purpose.
 */
export async function consumeChallenge(token, purpose) {
  if (typeof token !== 'string' || !token) return null
  const now = Date.now()
  const row = await get(
    `UPDATE auth_challenges SET used_at = $1
      WHERE token_hash = $2 AND purpose = $3 AND used_at IS NULL AND expires_at > $1
      RETURNING user_id`,
    now,
    tokenDigest(token),
    purpose,
  )
  return row?.user_id ?? null
}

/** Housekeeping for challenges nobody completed. Swept beside sessions and resets. */
export const purgeExpiredChallenges = () =>
  run('DELETE FROM auth_challenges WHERE expires_at <= $1', Date.now())
