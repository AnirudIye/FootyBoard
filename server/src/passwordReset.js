import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { get, run, transaction } from './db.js'
import { hashPassword } from './auth.js'
import { destroyAllSessions } from './sessions.js'

/**
 * Password reset tokens.
 *
 * The rules that make this safe rather than a back door:
 *   - the token is random and only its SHA-256 is stored, so a leaked database
 *     cannot be used to reset anyone's password;
 *   - it expires quickly and works exactly once;
 *   - using one invalidates every other outstanding token for that account;
 *   - and completing a reset destroys every existing session **and closes the
 *     sockets they were holding**, so an attacker who was already signed in is
 *     thrown out rather than keeping access. Deleting the rows alone was not
 *     that: a room is authorized once at the handshake, so the revoked session
 *     kept sending and receiving edits while every REST call it made answered
 *     401. `sessions.js` owns both halves now.
 *
 * A token is now issued by answering a security question rather than by
 * receiving an email, and is handed straight back in that response. None of the
 * above changes; what changes is how long it needs to live.
 */

/**
 * Fifteen minutes, down from thirty.
 *
 * The old figure was sized for a mail round trip: a queue, a spam folder, and
 * somebody getting to their inbox. Nothing is in the way now, the token is in
 * the response to the answer that earned it, and the page that receives it is
 * the next thing on screen. A window is a window whether or not anyone is
 * using it, so it should be no longer than the step actually takes.
 */
export const RESET_TTL_MS = 15 * 60 * 1000
export const RESET_TTL_MINUTES = RESET_TTL_MS / 60000

const digest = (token) => createHash('sha256').update(token).digest('hex')

/** Issues a token, replacing any still outstanding for that user. */
export async function createResetToken(userId) {
  const token = randomBytes(32).toString('base64url')
  await transaction(async (client) => {
    // The account row first, for the reason `sessions.js` gives at length: this
    // transaction touches a child table of `users`, and everything else that
    // touches that pair takes the parent first. Two orders is a deadlock.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    await client.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [userId])
    await client.query(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userId, digest(token), Date.now() + RESET_TTL_MS, new Date().toISOString()],
    )
  })
  return token
}

/**
 * Consumes a token and sets the new password. Everything happens in one
 * transaction: if any step fails the token is not burned and the old password
 * still stands, rather than leaving the account half-changed.
 *
 * The transaction is `destroyAllSessions`', which is what makes signing
 * everyone out inseparable from the change rather than a statement at the end
 * that could be dropped. The eviction it publishes lands after the commit.
 * Returns the account's id, or null, exactly as it always did.
 */
export async function consumeResetToken(token, newPassword) {
  // Derived before the claim below, so the transaction is not held open across
  // scrypt. It also costs an invalid token the same work as a valid one.
  const { hash, salt } = await hashPassword(newPassword)

  /**
   * **This read is not the check, and it must never be turned into one.**
   *
   * It answers one question — which account's row to lock — and it decides
   * nothing at all. The `UPDATE ... WHERE used_at IS NULL` below is still the
   * only thing that spends the token, so two requests carrying the same one
   * still cannot both pass: they queue on the account lock, the first moves
   * `used_at`, and the second's UPDATE matches no row and returns null through
   * the same path an expired token takes. The endpoint still cannot be used to
   * tell a token that never existed from one already spent.
   *
   * It exists because `destroyAllSessions` has to take the users row as its
   * first statement, and it cannot do that until somebody has said which row.
   * Claiming the token first is what put this transaction in the opposite order
   * to `POST /api/auth/password` and made the pair deadlock.
   */
  const claimant = await get(
    `SELECT user_id FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
    digest(token),
    Date.now(),
  )
  if (!claimant) return null

  return destroyAllSessions(claimant.user_id, async (client) => {
    /**
     * The claim *is* the check.
     *
     * Reading the row first and judging it in JavaScript left a window: two
     * requests carrying the same token could both see `used_at IS NULL` before
     * either committed, and both would go on to set a password. Making the
     * conditions part of the UPDATE means exactly one caller can move `used_at`
     * off NULL, so "works once" is enforced by the database rather than by
     * timing. One message for every failure mode either way, so the endpoint
     * still cannot be used to tell a token that never existed from one already
     * spent or merely expired.
     */
    const now = Date.now()
    const { rows } = await client.query(
      `UPDATE password_resets SET used_at = $1
        WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1
        RETURNING user_id`,
      [now, digest(token)],
    )
    const row = rows[0]
    if (!row) return null

    await client.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [
      hash,
      salt,
      row.user_id,
    ])
    // Any other outstanding link for this account is now void.
    await client.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [
      row.user_id,
    ])

    // Returning the id is what signs everyone out: `destroyAllSessions` deletes
    // every session for it in this same transaction and closes the sockets they
    // were holding once it commits. A stolen session must not survive the
    // password that was changed to stop it, and the room is where it used to.
    return row.user_id
  })
}

/** Housekeeping for links nobody followed. */
export const purgeExpiredResets = () =>
  run('DELETE FROM password_resets WHERE expires_at <= $1', Date.now())
