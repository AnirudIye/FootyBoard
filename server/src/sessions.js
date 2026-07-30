import { all, run, transaction, DB_NOW_MS } from './db.js'
import { SESSION_TTL_MS, tokenDigest } from './auth.js'
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
 *
 * **Publishing is not the same as arriving, which is why the eviction is also
 * written down.** The NOTIFY is the only thing that closes an open socket, and
 * an instance whose LISTEN connection is down when it is published never hears
 * it — so the row would be gone everywhere while one instance went on relaying
 * a revoked session's edits until it happened to disconnect. Every deletion
 * here therefore leaves a `session_revocations` row behind, and an instance
 * catching up after its listener reopens reads those rows and sweeps its rooms
 * again. See the reconciliation in `realtime.js` for the reading half.
 */

/** The socket half, applied on this instance and published to every other. */
const evict = (rows) => closeSessionSockets(rows.map((row) => row.id))

/**
 * The one statement that ends sessions, in whichever of the three shapes.
 *
 * It is one statement rather than a delete followed by an insert because that
 * is what makes "written in the same transaction" true by construction rather
 * than by every caller remembering to open one. Postgres runs a data-modifying
 * CTE exactly once and to completion whether or not the outer query reads it,
 * so `recorded` writes every row `gone` deleted, and a statement is its own
 * transaction wherever there is not already one around it. Neither half can
 * commit without the other in either direction: no session is destroyed without
 * a durable record of the eviction, and no record survives a revocation that
 * rolled back and therefore never happened.
 *
 * The returned ids come from `gone` rather than from the insert, so what gets
 * evicted on this instance is exactly what was deleted, whatever the insert
 * does. Returning the insert's rows instead would silently skip a socket the
 * moment anything was ever added to make that write forgiving.
 *
 * `where` is a clause written in this file and never a value — the value it
 * compares is bound as `$1`, which is the only parameter this statement takes.
 * The moment of revocation is the database's own clock rather than this
 * process's, because it is what another instance's watermark is compared
 * against and those two must be reading the same clock.
 */
const endingSessions = (where) => `
  WITH gone AS (
    DELETE FROM sessions WHERE ${where} RETURNING id, user_id
  ), recorded AS (
    INSERT INTO session_revocations (session_id, user_id, revoked_at)
    SELECT id, user_id, ${DB_NOW_MS} FROM gone
  )
  SELECT id FROM gone
`

/**
 * End one session: signing out of this browser, and nothing else.
 *
 * Deliberately not every session for the account. Signing out on the touchline
 * tablet must not close the laptop somebody is presenting from, which is the
 * whole reason evictions are matched on the session rather than on the user.
 */
export async function destroySession(token) {
  if (!token) return 0
  const rows = await all(endingSessions('token_hash = $1'), tokenDigest(token))
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
    const { rows } = await client.query(endingSessions('user_id = $1'), [userId])
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
  const rows = await all(endingSessions('expires_at <= $1'), Date.now())
  evict(rows)
  return rows.length
}

/**
 * How long a revocation is worth keeping, and why it is this long.
 *
 * Derived from the session TTL rather than written down beside it, because the
 * two are the same fact: a revocation's whole job is to let an instance that
 * missed the NOTIFY catch up, and past the point where the session it names
 * could still have been alive there is nothing left to catch up with. A session
 * created the instant before it was revoked had at most `SESSION_TTL_MS` to run,
 * and a session left alone that long is closed by `purgeExpiredSessions` above,
 * through this very statement. The extra day is slack rather than reasoning —
 * the sweep runs hourly and the row costs three columns.
 *
 * This does not pretend to cover a bus outage measured in weeks. An outage that
 * long is not an outage, it is the cluster being down, and every socket went
 * with it.
 */
export const REVOCATION_RETENTION_MS = SESSION_TTL_MS + 24 * 60 * 60 * 1000

/**
 * Sweep revocations nothing can still be catching up with.
 *
 * Beside the session purge rather than beside the other sweeps in `db.js`, for
 * the reason given above that one: this table exists only because ending a
 * session is two halves, and `db.js` has no business knowing about the second.
 */
export async function purgeExpiredRevocations() {
  const { changes } = await run(
    'DELETE FROM session_revocations WHERE revoked_at < $1',
    Date.now() - REVOCATION_RETENTION_MS,
  )
  return changes
}
