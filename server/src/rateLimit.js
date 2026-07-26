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
 * One statement per update. Doing this as read-then-write would let two
 * instances interleave and lose a failure; the upsert makes each increment
 * atomic no matter how many processes are counting.
 */
const writeRecord = (key, count, lockedUntil, lastAttempt) =>
  run(
    `INSERT INTO login_attempts (key, count, locked_until, last_attempt)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       count        = EXCLUDED.count,
       locked_until = EXCLUDED.locked_until,
       last_attempt = EXCLUDED.last_attempt`,
    key,
    count,
    lockedUntil,
    lastAttempt,
  )

const secondsUntil = (timestamp) => Math.max(1, Math.ceil((timestamp - Date.now()) / 1000))

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

  const account = await readRecord(`account:${email}`)
  const accountCount = account && Number(account.locked_until) <= now ? account.count + 1 : 1
  await writeRecord(
    `account:${email}`,
    accountCount,
    accountCount >= MAX_ACCOUNT_ATTEMPTS ? now + ACCOUNT_LOCKOUT_MS : 0,
    now,
  )

  const perIp = await readRecord(`ip:${ip}`)
  // The IP window rolls: a quiet period resets the count rather than banking it.
  const stale = !perIp || now - Number(perIp.last_attempt) > IP_WINDOW_MS
  const ipCount = stale ? 1 : perIp.count + 1
  await writeRecord(`ip:${ip}`, ipCount, ipCount >= MAX_IP_ATTEMPTS ? now + IP_WINDOW_MS : 0, now)
}

export const clearFailures = ({ email }) =>
  run('DELETE FROM login_attempts WHERE key = $1', `account:${email}`)

/** Generic limiter for non-auth routes, keyed however the caller likes. */
export async function consume(key, { max, windowMs, message }) {
  const now = Date.now()
  const record = await readRecord(key)
  const stale = !record || now - Number(record.last_attempt) > windowMs
  const count = stale ? 1 : record.count + 1

  if (!stale && Number(record.locked_until) > now) {
    throw new TooManyRequests(message, secondsUntil(Number(record.locked_until)))
  }

  await writeRecord(key, count, count >= max ? now + windowMs : 0, now)
  if (count >= max) throw new TooManyRequests(message, Math.ceil(windowMs / 1000))
}
