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
 *
 * **There is a second rule now, and it is about lock order: the account row
 * first, then anything hanging off it.** Every transaction here touches several
 * of one account's tables, and two of them used to take `password_resets` and
 * `users` in opposite orders — `consumeResetToken` claimed the token and then
 * updated the password, while `POST /api/auth/password` updated the password and
 * then voided the tokens. Each ends up holding what the other is waiting for,
 * which is a deadlock, and Postgres resolves it by killing one of them with
 * `40P01`. On the password-recovery path that surfaces as a 500, and it is a
 * reset that did not happen, at the moment somebody believes an intruder is in
 * their account.
 *
 * The order is forced rather than chosen. `DELETE /api/auth/me` deletes the
 * users row and lets the cascade take `sessions`, `password_resets`, `boards`
 * and the rest; a parent delete cannot be made to take a child row first, so any
 * order putting a child ahead of `users` is one that account deletion is
 * structurally unable to obey. Users-first is the only order all of them can
 * share, so `destroyAllSessions` takes that row as its transaction's first
 * statement, and takes it here rather than asking each caller to remember —
 * which is the argument the eviction rule above already makes.
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
 *
 * **`doomed` exists to fix an order, not to select anything the delete could not
 * select itself.** The three shapes below scan three different indexes — by
 * token, by account, by expiry — so two of them deleting an overlapping set of
 * rows could take those rows in opposite orders and deadlock. Locking by primary
 * key first means they cannot, whatever their scans do. It costs the hot path
 * (one sign-out, one row) a second indexed lookup.
 */
const endingSessions = (where) => `
  WITH doomed AS (
    SELECT id FROM sessions WHERE ${where} ORDER BY id FOR UPDATE
  ), gone AS (
    DELETE FROM sessions WHERE id IN (SELECT id FROM doomed) RETURNING id, user_id
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

/** Takes the account row, which is the first thing any of these transactions does. */
const LOCK_ACCOUNT = 'SELECT id FROM users WHERE id = $1 FOR UPDATE'

/**
 * End every session for an account, along with whatever else has to happen in
 * the same breath.
 *
 * `within` runs inside the transaction that deletes them and returns a truthy
 * value to go on, or null to abandon the whole thing. That shape is the point:
 * the password change and the session destruction commit together, so a failure
 * cannot leave a changed password with the old sessions still live, and there
 * is no arrangement of these statements in which a caller destroys sessions and
 * forgets to evict them.
 *
 * **The account is named up front rather than learned from `within`**, and that
 * is the whole of the lock-order rule at the top of this file. The id used to
 * arrive as `within`'s return value, which meant this function could not
 * possibly take the users row first: it did not know which row until the
 * caller's own statements had already run and taken their locks. Now it does,
 * so `LOCK_ACCOUNT` runs first and every transaction on one account is
 * serialized at its first statement. Two of them can no longer each be holding
 * a row the other is waiting for.
 *
 * `FOR UPDATE` rather than the weaker `FOR NO KEY UPDATE`: the weak mode does
 * not conflict with the `FOR KEY SHARE` a foreign-key check takes, so
 * `createResetToken` inserting a child row would still be able to overtake the
 * cascade in `DELETE /api/auth/me`. The cost is that a concurrent sign-in for
 * this one account waits, for the length of this transaction, while its
 * password or its sessions are being changed. That is milliseconds, on the
 * account being changed, and is arguably what you want anyway.
 *
 * The eviction is published **after** the commit, never inside it. A rolled-back
 * transaction that had already thrown everyone out would sign people out of an
 * account whose password never actually changed.
 *
 * Returns the account's id, or null, exactly as it always did.
 */
export async function destroyAllSessions(userId, within = () => userId) {
  if (!userId) return null

  const outcome = await transaction(async (client) => {
    await client.query(LOCK_ACCOUNT, [userId])
    // `within` still decides whether to go on: a reset token that lost the race
    // returns null here and the whole transaction rolls back, taking the lock
    // with it rather than committing an account lock and nothing else.
    if (!(await within(client))) return null
    const { rows } = await client.query(endingSessions('user_id = $1'), [userId])
    return { rows }
  })

  if (!outcome) return null
  evict(outcome.rows)
  return userId
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
