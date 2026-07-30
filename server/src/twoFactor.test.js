import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { migrate, get, all, run, closePool } from './db.js'
import { initEncryption } from './crypto.js'
import { codeForStep, stepAt } from './totp.js'
import {
  beginEnrollment,
  confirmEnrollment,
  verifyFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
  remainingRecoveryCodes,
  createChallenge,
  consumeChallenge,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from './twoFactor.js'

/**
 * The storage half of the second factor, against a real Postgres.
 *
 * No port and no spawned instance, because nothing asserted here is an HTTP
 * behaviour: every property below is a property of a SQL statement, and putting
 * a route in front of it would only make the failures harder to read. The
 * routes get their own suites in `twoFactorEnroll.test.js` and
 * `twoFactorLogin.test.js`, each on a port of its own. Those port numbers are
 * named by file rather than by number here, so that grepping the tree for a port
 * still answers "which one file claims it" rather than turning up every
 * neighbour that mentioned it in passing.
 *
 * What is worth asserting is the set of things that would make the factor
 * decorative rather than real:
 *
 *   - the secret is not sitting in the database in a form somebody reading a
 *     backup can type into their own authenticator;
 *   - an enrollment that was started and abandoned turns nothing on, so
 *     `totp_confirmed_at` is the switch and `totp_secret` is not;
 *   - a code cannot be spent twice inside the ninety seconds it is live, which
 *     is a real attack rather than a tidiness concern: whoever read it over a
 *     shoulder has a window;
 *   - a recovery code cannot be spent twice at all;
 *   - and a challenge issued for one purpose cannot be spent on the other,
 *     which is what stops one factor check buying a different privilege.
 */

const users = []

/**
 * A real account, inserted directly. Nothing here goes through `/signup`,
 * because that route's per-IP allowance is a row shared with every other suite
 * running concurrently against this same database.
 */
async function makeUser() {
  const id = randomUUID()
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at,
                        display_name)
     VALUES ($1, $2, 'x', 'x', $3, $3, 'Factor Tester')`,
    id,
    `${id}@test.invalid`,
    new Date().toISOString(),
  )
  users.push(id)
  return id
}

const userRow = (id) =>
  get('SELECT totp_secret, totp_confirmed_at, totp_last_step FROM users WHERE id = $1', id)

/** The code an authenticator would be showing right now for this secret. */
const currentCode = (secret) => codeForStep(secret, stepAt())

before(async () => {
  await migrate()
  // `encrypt` refuses to run before a key is resolved, and nothing has booted an
  // instance in this process. In `test` a key derived from SESSION_SECRET is
  // allowed, which is the same weakness board contents already carry in a dev
  // database and is written down in `crypto.js`.
  initEncryption()
})

after(async () => {
  // Recovery codes and challenges cascade from the account, so the accounts are
  // the whole cleanup. Nothing here spends a rate-limit allowance.
  for (const id of users) await run('DELETE FROM users WHERE id = $1', id)
  await closePool()
})

test('the three columns exist, are nullable, and a row that predates them is untouched', async () => {
  const id = await makeUser()

  const columns = await all(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = ANY($1)`,
    ['totp_secret', 'totp_confirmed_at', 'totp_last_step'],
  )
  assert.equal(columns.length, 3, 'a column is missing from users')
  for (const column of columns) {
    // Nullable is the whole design: an account with no factor has to be a row
    // with three NULLs rather than a row that failed to migrate.
    assert.equal(column.is_nullable, 'YES', `${column.column_name} is NOT NULL`)
  }

  // Running the migration again over an existing account changes nothing. This
  // is the `boardMigration` property applied to these columns: `ADD COLUMN IF
  // NOT EXISTS` on a second boot must not disturb what is already stored.
  await migrate()
  const row = await userRow(id)
  assert.deepEqual(row, { totp_secret: null, totp_confirmed_at: null, totp_last_step: null })
})

test('an enrollment writes a sealed secret and turns nothing on', async () => {
  const id = await makeUser()

  const { secret, uri } = await beginEnrollment(id, `${id}@test.invalid`)
  assert.match(secret, /^[A-Z2-7]{32}$/)
  assert.ok(uri.startsWith('otpauth://totp/'), uri)

  const row = await userRow(id)
  /**
   * The secret is recoverable by construction, since the server has to compute
   * the same HMAC the phone does, so it cannot be hashed the way the password
   * and the security answer are. Sealing it is what is available instead: a
   * stolen database without `ENCRYPTION_KEY` yields no working factors.
   */
  assert.ok(row.totp_secret, 'nothing was stored')
  assert.ok(
    !row.totp_secret.includes(secret),
    'the base32 secret is in the users row in readable form',
  )
  assert.ok(row.totp_secret.startsWith('v1:'), 'the secret is not sealed at all')

  // And nothing is on yet. An enrollment somebody started and walked away from
  // must not be a lockout, which is why every login path reads
  // `totp_confirmed_at` and never `totp_secret`.
  assert.equal(row.totp_confirmed_at, null)
  assert.equal(await remainingRecoveryCodes(id), 0)
})

test('a wrong code confirms nothing, and a right one turns it on with ten codes attached', async () => {
  const id = await makeUser()
  const { secret } = await beginEnrollment(id, `${id}@test.invalid`)

  assert.equal(await confirmEnrollment(id, '000000'), null)
  assert.equal((await userRow(id)).totp_confirmed_at, null, 'a wrong code turned 2FA on')
  assert.equal(
    (await all('SELECT id FROM recovery_codes WHERE user_id = $1', id)).length,
    0,
    'a wrong code wrote recovery codes',
  )

  const codes = await confirmEnrollment(id, currentCode(secret))
  assert.ok(Array.isArray(codes))
  assert.equal(codes.length, RECOVERY_CODE_COUNT)
  for (const code of codes) assert.match(code, /^[A-Z]{4}-[A-Z]{4}-[A-Z]{4}-[A-Z]{4}$/)
  // Ten distinct codes, not one drawn ten times.
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT)

  assert.ok((await userRow(id)).totp_confirmed_at, 'the switch was not set')
  assert.equal(await remainingRecoveryCodes(id), RECOVERY_CODE_COUNT)

  // Stored as digests, so the row is not ten more ways into the account.
  const stored = await all('SELECT code_hash FROM recovery_codes WHERE user_id = $1', id)
  assert.equal(stored.length, RECOVERY_CODE_COUNT)
  for (const row of stored) assert.match(row.code_hash, /^[0-9a-f]{64}$/)
  const plain = codes.map((c) => c.replace(/-/g, ''))
  for (const row of stored) assert.ok(!plain.includes(row.code_hash))

  // Enrollment is not re-entrant: the switch is written once and only once.
  assert.equal(await confirmEnrollment(id, currentCode(secret)), null)
})

test('the same TOTP code cannot be spent twice inside its window', async () => {
  const id = await makeUser()
  const { secret } = await beginEnrollment(id, `${id}@test.invalid`)
  await confirmEnrollment(id, currentCode(secret))

  /**
   * Confirming banks the step it was confirmed on, so the next code is what a
   * second sign-in would actually carry. The window accepts it a step early,
   * which is what makes this assertable without waiting thirty seconds.
   */
  const next = codeForStep(secret, stepAt() + 1)

  assert.equal(await verifyFactor(id, next), true, 'a live code was refused')
  const afterFirst = (await userRow(id)).totp_last_step

  assert.equal(await verifyFactor(id, next), false, 'the same code was accepted twice')
  assert.equal(
    (await userRow(id)).totp_last_step,
    afterFirst,
    'a refused replay still moved the watermark',
  )

  /**
   * And the watermark only ever moves forward, so a code from an *earlier* step
   * that is still inside the ninety second window is refused as well.
   *
   * That is stricter than "refuse the exact code again" and it is deliberate:
   * `totp_last_step` is one number rather than a set of spent steps, so once a
   * step is banked every step at or below it is spent too. Somebody who captured
   * the previous code and raced to use it gets nothing, and the cost is that a
   * person who types the code that has just rolled over signs in again with the
   * new one. Worth knowing this is what the single column buys.
   */
  assert.equal(
    await verifyFactor(id, codeForStep(secret, stepAt())),
    false,
    'a code from a step already behind the watermark was accepted',
  )
})

test('a recovery code works once, in whatever shape it is typed', async () => {
  const id = await makeUser()
  const { secret } = await beginEnrollment(id, `${id}@test.invalid`)
  const codes = await confirmEnrollment(id, currentCode(secret))

  // Lowercase, spaces instead of hyphens: the shape somebody retypes it in is
  // never the difference between getting back in and being locked out.
  const retyped = codes[0].replace(/-/g, ' ').toLowerCase()
  assert.notEqual(retyped, codes[0])

  assert.equal(await verifyFactor(id, retyped), true, 'a retyped recovery code was refused')
  assert.equal(await remainingRecoveryCodes(id), RECOVERY_CODE_COUNT - 1)

  // Single use, enforced by `used_at IS NULL` in the UPDATE rather than by
  // reading the row and judging it here.
  assert.equal(await verifyFactor(id, codes[0]), false, 'a recovery code was spent twice')
  assert.equal(await verifyFactor(id, retyped), false)
  assert.equal(await remainingRecoveryCodes(id), RECOVERY_CODE_COUNT - 1)

  const spent = await all(
    'SELECT used_at FROM recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
    id,
  )
  assert.equal(spent.length, 1, 'used_at moved on more than one row')

  // A code that was never issued is refused, and so is nonsense.
  assert.equal(await verifyFactor(id, 'ABCD-EFGH-JKLM-NPQR'), false)
  assert.equal(await verifyFactor(id, ''), false)
  assert.equal(await verifyFactor(id, null), false)
})

test('normalizeRecoveryCode accepts what a person types and nothing else', () => {
  assert.equal(normalizeRecoveryCode('abcd-efgh-jklm-npqr'), 'ABCDEFGHJKLMNPQR')
  assert.equal(normalizeRecoveryCode('  ABCD EFGH JKLM NPQR '), 'ABCDEFGHJKLMNPQR')
  // Too short, too long, and characters the alphabet deliberately leaves out.
  assert.equal(normalizeRecoveryCode('ABCDEFGHJKLMNPQ'), null)
  assert.equal(normalizeRecoveryCode('ABCDEFGHJKLMNPQRS'), null)
  assert.equal(normalizeRecoveryCode('ABCDEFGHJKLMNPQ0'), null)
  assert.equal(normalizeRecoveryCode('ABCDEFGHJKLMNPQI'), null)
  assert.equal(normalizeRecoveryCode(null), null)
  assert.equal(normalizeRecoveryCode(123), null)
})

test('regenerating replaces all ten, and disabling leaves nothing behind', async () => {
  const id = await makeUser()
  const { secret } = await beginEnrollment(id, `${id}@test.invalid`)
  const first = await confirmEnrollment(id, currentCode(secret))

  const second = await regenerateRecoveryCodes(id)
  assert.equal(second.length, RECOVERY_CODE_COUNT)
  assert.equal(await remainingRecoveryCodes(id), RECOVERY_CODE_COUNT)
  // A fresh set of ten is ten new ways in, so the old ten have to stop being
  // ways in at the same moment.
  assert.equal(await verifyFactor(id, first[0]), false, 'an old recovery code survived')
  assert.equal(await verifyFactor(id, second[0]), true)

  await disableTwoFactor(id)
  assert.deepEqual(await userRow(id), {
    totp_secret: null,
    totp_confirmed_at: null,
    totp_last_step: null,
  })
  assert.equal((await all('SELECT id FROM recovery_codes WHERE user_id = $1', id)).length, 0)
  assert.equal(await verifyFactor(id, second[1]), false, 'a code survived the factor being off')
})

test('a challenge is single use, purpose bound, and expires', async () => {
  const id = await makeUser()

  const login = await createChallenge(id, 'login')
  const reset = await createChallenge(id, 'reset')

  /**
   * Purpose is compared in the same statement that claims the row. Without it,
   * a factor met on the recovery path would be spendable at `/login/2fa` and
   * the second factor would have been proved once and reused for a different
   * privilege.
   */
  assert.equal(await consumeChallenge(reset, 'login'), null, 'a reset challenge opened a login')
  assert.equal(await consumeChallenge(login, 'reset'), null, 'a login challenge opened a reset')

  assert.equal(await consumeChallenge(login, 'login'), id)
  assert.equal(await consumeChallenge(login, 'login'), null, 'a challenge was spent twice')

  // The claim is the check, so nothing here is a read followed by a decision.
  assert.equal(await consumeChallenge('not-a-token', 'login'), null)
  assert.equal(await consumeChallenge('', 'login'), null)

  // Expiry, aged directly rather than by waiting five minutes.
  const stale = await createChallenge(id, 'login')
  await run('UPDATE auth_challenges SET expires_at = $1 WHERE user_id = $2 AND used_at IS NULL',
    Date.now() - 1000, id)
  assert.equal(await consumeChallenge(stale, 'login'), null, 'an expired challenge was accepted')
})

test('verifyFactor answers false for an account with no confirmed factor', async () => {
  const id = await makeUser()

  // Nothing enrolled at all.
  assert.equal(await verifyFactor(id, '000000'), false)

  // And an enrollment that was started and abandoned. This is the case that
  // would be a silent bypass if anything read `totp_secret` as the switch: the
  // secret exists, so a caller who had seen it could produce a valid code.
  const { secret } = await beginEnrollment(id, `${id}@test.invalid`)
  assert.equal(
    await verifyFactor(id, currentCode(secret)),
    false,
    'an unconfirmed enrollment let a code through',
  )
})
