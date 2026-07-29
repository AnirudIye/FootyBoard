import { all, transaction } from './db.js'
import { tokenDigest } from './auth.js'
import { closeSessionSockets } from './realtime.js'

/**
 * Ending a session, everywhere it is.
 *
 * There is one rule here and everything in this file exists to make it hard to
 * break: **a session's socket dies with the session's row.**
 *
 * The row was always the easy half. `userForToken` reads it on every request,
 * so deleting it stops the next `GET /api/boards` immediately and on every
 * instance. A WebSocket is not like that. It is authorized once, during the
 * handshake, and never again, so a `DELETE FROM sessions` says nothing to a
 * connection that is already open: it goes on relaying that person's edits into
 * the room, and the room's edits back to them, until they close the tab.
 *
 * That is not a cosmetic gap, because of *which* feature makes the promise.
 * Password recovery destroys every session on purpose, so that somebody who
 * believes another person is in their account can throw them out. Recovery is
 * the control you reach for when you already think you have been robbed. An
 * attacker whose REST calls all answer 401 while their live room keeps working
 * in both directions has not been thrown out of anything.
 *
 * So every path that deletes from `sessions` goes through this file, and every
 * function here publishes the eviction itself rather than returning ids and
 * trusting its caller to pass them on. `DELETE FROM sessions` written anywhere
 * else is the defect coming back.
 */

/** The socket half, applied on this instance and published to every other. */
const evict = (rows) => closeSessionSockets(rows.map((row) => row.id))

/**
 * End one session: signing out of this browser, and nothing else.
 *
 * Deliberately not every session for the account. Signing out on the touchline
 * tablet must not close the laptop somebody is presenting from, which is the
 * whole reason evictions are matched on the session rather than on the user.
 */
export async function destroySession(token) {
  if (!token) return 0
  const rows = await all(
    'DELETE FROM sessions WHERE token_hash = $1 RETURNING id',
    tokenDigest(token),
  )
  evict(rows)
  return rows.length
}

/**
 * End every session for an account, along with whatever else has to happen in
 * the same breath.
 *
 * `within` runs inside the transaction that deletes them and returns the
 * account's id, or null to abandon the whole thing. That shape is the point:
 * the password change and the session destruction commit together, so a failure
 * cannot leave a changed password with the old sessions still live, and there
 * is no arrangement of these statements in which a caller destroys sessions and
 * forgets to evict them.
 *
 * The eviction is published **after** the commit, never inside it. A rolled-back
 * transaction that had already thrown everyone out would sign people out of an
 * account whose password never actually changed.
 *
 * Returns whatever `within` returned, so a caller that was already answering
 * "which account was this?" keeps answering it.
 */
export async function destroyAllSessions(within) {
  const outcome = await transaction(async (client) => {
    const userId = await within(client)
    if (!userId) return null
    const { rows } = await client.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', [
      userId,
    ])
    return { userId, rows }
  })

  if (!outcome) return null
  evict(outcome.rows)
  return outcome.userId
}

/**
 * Housekeeping for sessions nobody came back to, and the same rule again.
 *
 * An expired session is already refused by `userForToken`, which compares
 * `expires_at` rather than trusting this sweep to have run. The socket is the
 * part that would otherwise not notice: without the eviction here, a connection
 * opened on day 29 outlives its own credential indefinitely, since nothing
 * re-checks a socket after the handshake. Only one instance sweeps, which is
 * fine, because the eviction it publishes reaches all of them.
 *
 * It lives here rather than beside the other purges in `db.js` for the reason
 * this whole file exists: a `DELETE FROM sessions` that does not evict is the
 * defect, wherever it is written.
 */
export async function purgeExpiredSessions() {
  const rows = await all('DELETE FROM sessions WHERE expires_at <= $1 RETURNING id', Date.now())
  evict(rows)
  return rows.length
}
