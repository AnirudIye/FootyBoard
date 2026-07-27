import { createHash } from 'node:crypto'
import { get, run } from './db.js'

/**
 * Two independent limits, because they stop different attacks:
 *
 *  - Per-account lockout catches someone guessing one person's password.
 *  - Per-IP limiting catches someone spraying one common password across many
 *    accounts, which a per-account counter would never notice.
 *
 * Both live in Postgres rather than in memory, which is what lets them hold
 * across API instances: five failures spread over five processes still lock
 * the account, because they all increment the same row.
 */

const MAX_ACCOUNT_ATTEMPTS = 5
const ACCOUNT_LOCKOUT_MS = 15 * 60 * 1000

const MAX_IP_ATTEMPTS = 30
const IP_WINDOW_MS = 10 * 60 * 1000

const MIN_GAP_MS = 500

/**
 * The account counter has no rolling window: it is reset by serving a lockout,
 * never by going quiet. Passing a span nothing can outlast says that in the
 * one statement below without giving it a second shape.
 */
const NEVER_STALE_MS = Number.MAX_SAFE_INTEGER

export class TooManyRequests extends Error {
  constructor(message, retryAfterSeconds) {
    super(message)
    this.name = 'TooManyRequests'
    this.status = 429
    this.retryAfter = retryAfterSeconds
  }
}

const readRecord = (key) =>
  get('SELECT key, count, locked_until, last_attempt FROM login_attempts WHERE key = $1', key)

/**
 * The whole read-modify-write, as one statement.
 *
 * This used to be a SELECT, a decision in JavaScript, and an upsert that set
 * `count = EXCLUDED.count`. That is not an increment, it is last-writer-wins:
 * a hundred requests arriving together all read count 0 and all wrote 1, so an
 * allowance of ten never fired however hard it was hit. Which mattered, because
 * this limiter is the entire defence for a six-letter join code — the thing it
 * was least able to survive was exactly the parallel guessing it exists to stop.
 *
 * So the counter is `login_attempts.count + 1` evaluated by Postgres, and every
 * decision that used to live in JavaScript lives in the CASE arms:
 *
 *  - a held lockout leaves the row completely alone, count and clock alike, so
 *    being refused does not push the window out in front of the caller;
 *  - a window that has rolled over starts again at one;
 *  - anything else counts up, and trips the lock as it crosses the limit.
 *
 * `ON CONFLICT DO UPDATE` is what makes it atomic: a second writer landing on
 * the same key waits for the first to commit and then re-evaluates the arms
 * against the row it actually left behind, rather than the one it read earlier.
 *
 * `hold` is the difference between the two callers. A limiter that turns people
 * away holds the row still while it does; the login recorder always counts,
 * because the caller in front of it has already been refused by
 * `assertMayAttempt` before it gets here.
 */
const BUMP_SQL = `
  INSERT INTO login_attempts AS a (key, count, locked_until, last_attempt)
  VALUES ($1, 1, CASE WHEN 1 >= $4::int THEN $2::bigint + $5::bigint ELSE 0 END, $2::bigint)
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN $6::boolean AND a.locked_until > $2::bigint            THEN a.count
      WHEN a.locked_until > 0 AND a.locked_until <= $2::bigint    THEN 1
      WHEN $2::bigint - a.last_attempt > $3::bigint               THEN 1
      ELSE a.count + 1
    END,
    locked_until = CASE
      WHEN $6::boolean AND a.locked_until > $2::bigint            THEN a.locked_until
      WHEN (CASE
              WHEN a.locked_until > 0 AND a.locked_until <= $2::bigint THEN 1
              WHEN $2::bigint - a.last_attempt > $3::bigint            THEN 1
              ELSE a.count + 1
            END) >= $4::int                                       THEN $2::bigint + $5::bigint
      ELSE 0
    END,
    last_attempt = CASE
      WHEN $6::boolean AND a.locked_until > $2::bigint            THEN a.last_attempt
      ELSE $2::bigint
    END
  RETURNING a.count, a.locked_until`

const bump = (key, { now, staleAfterMs, max, lockoutMs, hold }) =>
  get(BUMP_SQL, key, now, staleAfterMs, max, lockoutMs, hold)

const secondsUntil = (timestamp) => Math.max(1, Math.ceil((timestamp - Date.now()) / 1000))

/**
 * Per-address allowances are keyed on a digest of the address, never on the
 * address itself.
 *
 * `forgot:` counts something taken straight out of an unauthenticated request
 * body. Writing that in verbatim turns a counting table into an unbounded set
 * of arbitrary strings and, worse, a list of the addresses strangers have been
 * asking about. The digest counts exactly as well and records neither.
 */
export const addressKey = (prefix, email) =>
  `${prefix}:${createHash('sha256').update(email).digest('hex')}`

/** Hands an allowance back, for when the thing it was guarding has happened. */
export const clearAllowance = (key) =>
  run('DELETE FROM login_attempts WHERE key = $1', key)

/**
 * Throws if this address or IP may not attempt a sign-in right now. Checked
 * before the password is verified, so a locked account costs an attacker the
 * same whether or not it exists.
 */
export async function assertMayAttempt({ email, ip }) {
  const account = await readRecord(`account:${email}`)
  if (account && Number(account.locked_until) > Date.now()) {
    const wait = secondsUntil(Number(account.locked_until))
    throw new TooManyRequests(
      `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minutes.`,
      wait,
    )
  }
  if (account && Date.now() - Number(account.last_attempt) < MIN_GAP_MS) {
    throw new TooManyRequests('That was too quick. Wait a moment and try again.', 1)
  }

  const perIp = await readRecord(`ip:${ip}`)
  if (perIp && Number(perIp.locked_until) > Date.now()) {
    throw new TooManyRequests(
      'Too many attempts from this network. Try again shortly.',
      secondsUntil(Number(perIp.locked_until)),
    )
  }
}

export async function recordFailure({ email, ip }) {
  const now = Date.now()

  // A lockout that has been served starts the count over. Carrying it forward
  // meant the sixth failure was still >= the limit, so one wrong password every
  // fifteen minutes re-locked the account indefinitely: a user who mistyped
  // once after waiting was locked out again, and anyone who knew an address
  // could hold it shut for good.
  await bump(`account:${email}`, {
    now,
    staleAfterMs: NEVER_STALE_MS,
    max: MAX_ACCOUNT_ATTEMPTS,
    lockoutMs: ACCOUNT_LOCKOUT_MS,
    hold: false,
  })

  // The IP window rolls: a quiet period resets the count rather than banking it.
  await bump(`ip:${ip}`, {
    now,
    staleAfterMs: IP_WINDOW_MS,
    max: MAX_IP_ATTEMPTS,
    lockoutMs: IP_WINDOW_MS,
    hold: false,
  })
}

export const clearFailures = ({ email }) =>
  run('DELETE FROM login_attempts WHERE key = $1', `account:${email}`)

/**
 * Generic limiter for non-auth routes, keyed however the caller likes.
 *
 * One round trip, and the row that comes back is the one that was actually
 * written, so "did this attempt trip the limit" and "was it already tripped"
 * are the same question: a lock in the future means turn them away.
 */
export async function consume(key, { max, windowMs, message }) {
  const now = Date.now()
  const record = await bump(key, {
    now,
    staleAfterMs: windowMs,
    max,
    lockoutMs: windowMs,
    hold: true,
  })
  const lockedUntil = Number(record.locked_until)
  if (lockedUntil > now) throw new TooManyRequests(message, secondsUntil(lockedUntil))
}
