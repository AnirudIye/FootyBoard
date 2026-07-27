import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { run, transaction } from './db.js'
import { hashPassword } from './auth.js'

/**
 * Password reset tokens.
 *
 * The rules that make this safe rather than a back door:
 *   - the token is random and only its SHA-256 is stored, so a leaked database
 *     cannot be used to reset anyone's password;
 *   - it expires quickly and works exactly once;
 *   - using one invalidates every other outstanding token for that account;
 *   - and completing a reset destroys every existing session, so an attacker
 *     who was already signed in is thrown out rather than keeping access.
 */

export const RESET_TTL_MS = 30 * 60 * 1000
export const RESET_TTL_MINUTES = RESET_TTL_MS / 60000

const digest = (token) => createHash('sha256').update(token).digest('hex')

/** Issues a token, replacing any still outstanding for that user. */
export async function createResetToken(userId) {
  const token = randomBytes(32).toString('base64url')
  await transaction(async (client) => {
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
 */
export async function consumeResetToken(token, newPassword) {
  // Derived before the claim below, so the transaction is not held open across
  // scrypt. It also costs an invalid token the same work as a valid one.
  const { hash, salt } = await hashPassword(newPassword)

  return transaction(async (client) => {
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
    // Signing everyone out is the point: a stolen session must not survive the
    // password that was changed to stop it.
    await client.query('DELETE FROM sessions WHERE user_id = $1', [row.user_id])

    return row.user_id
  })
}

/** Housekeeping for links nobody followed. */
export const purgeExpiredResets = () =>
  run('DELETE FROM password_resets WHERE expires_at <= $1', Date.now())
