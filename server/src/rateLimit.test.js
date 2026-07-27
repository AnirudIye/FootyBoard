import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { migrate, run, get, closePool } from './db.js'
import {
  consume,
  recordFailure,
  assertMayAttempt,
  clearFailures,
  TooManyRequests,
} from './rateLimit.js'

/**
 * The limiters, under the traffic they exist to survive.
 *
 * These run against a real Postgres because the property under test is not
 * "does the counter count", it is "does it count correctly when many callers
 * hit one key at once". The limiter used to be a SELECT, a decision in
 * JavaScript, and an upsert that wrote the count it had computed — so a hundred
 * requests arriving together all read zero and all wrote one, and an allowance
 * of ten never fired. A sequential test passes happily against that; only a
 * concurrent one fails.
 */

const keys = []

/** A key nothing else in the suite can be counting. */
const freshKey = (prefix) => {
  const key = `${prefix}:${randomUUID()}`
  keys.push(key)
  return key
}

const countFor = (key) => get('SELECT count, locked_until FROM login_attempts WHERE key = $1', key)

/** Settles every call, so one refusal does not hide the rest. */
const settle = (promises) =>
  Promise.all(promises.map((p) => p.then(() => 'allowed', (err) => err)))

before(() => migrate())

after(async () => {
  for (const key of keys) await run('DELETE FROM login_attempts WHERE key = $1', key)
  await closePool()
})

test('an allowance holds when it is spent all at once rather than in turn', async () => {
  const key = freshKey('test-join')
  const limit = { max: 10, windowMs: 60_000, message: 'no' }

  const results = await settle(Array.from({ length: 50 }, () => consume(key, limit)))
  const allowed = results.filter((r) => r === 'allowed').length
  const refused = results.filter((r) => r instanceof TooManyRequests).length

  // Nine get through and the tenth trips the lock, exactly as they would one at
  // a time. The old read-then-write let all fifty through.
  assert.equal(allowed, 9, `${allowed} of 50 concurrent attempts were allowed`)
  assert.equal(refused, 41)

  const row = await countFor(key)
  assert.equal(row.count, 10, 'the count is an increment, not the last writer')
  assert.ok(Number(row.locked_until) > Date.now(), 'and the lock is held')
})

test('being refused does not push the window out in front of the caller', async () => {
  // A rejected attempt must leave the row alone. Stamping `last_attempt` on the
  // way past would move the moment the lock expires forward on every retry, so
  // anyone politely retrying would never be let back in.
  const key = freshKey('test-hold')
  const limit = { max: 2, windowMs: 60_000, message: 'no' }

  await consume(key, limit)
  await assert.rejects(() => consume(key, limit), TooManyRequests)
  const first = await countFor(key)

  await assert.rejects(() => consume(key, limit), TooManyRequests)
  await assert.rejects(() => consume(key, limit), TooManyRequests)
  const later = await countFor(key)

  assert.equal(Number(later.locked_until), Number(first.locked_until))
  assert.equal(later.count, first.count)
})

test('a window that has rolled over starts the count again', async () => {
  const key = freshKey('test-window')
  const limit = { max: 3, windowMs: 60_000, message: 'no' }

  await consume(key, limit)
  await consume(key, limit)

  // Age the row rather than waiting out the window.
  await run('UPDATE login_attempts SET last_attempt = $1 WHERE key = $2', Date.now() - 120_000, key)

  await consume(key, limit)
  assert.equal((await countFor(key)).count, 1, 'a quiet period resets rather than banking')
})

test('concurrent wrong passwords still lock the account', async () => {
  const email = `${randomUUID()}@test.invalid`
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`
  keys.push(`account:${email}`, `ip:${ip}`)

  // Five is the allowance, so twenty at once must not leave it open. Spread
  // across instances these would be five separate processes writing one row.
  await settle(Array.from({ length: 20 }, () => recordFailure({ email, ip })))

  await assert.rejects(
    () => assertMayAttempt({ email, ip }),
    (err) => err instanceof TooManyRequests && /failed sign-ins/.test(err.message),
  )

  // And signing in successfully hands the account back.
  await clearFailures({ email })
  assert.equal(await countFor(`account:${email}`), null)
})

test('a served lockout starts the account over rather than re-locking on the next mistake', async () => {
  // Carrying the count forward meant the sixth failure was still at the limit,
  // so one wrong password every fifteen minutes held an address shut for good.
  const email = `${randomUUID()}@test.invalid`
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`
  keys.push(`account:${email}`, `ip:${ip}`)

  for (let i = 0; i < 5; i++) await recordFailure({ email, ip })
  assert.ok(Number((await countFor(`account:${email}`)).locked_until) > Date.now())

  // Serve it.
  await run(
    'UPDATE login_attempts SET locked_until = $1 WHERE key = $2',
    Date.now() - 1000,
    `account:${email}`,
  )

  await recordFailure({ email, ip })
  const row = await countFor(`account:${email}`)
  assert.equal(row.count, 1, 'the sixth failure is the first of a new run')
  assert.equal(Number(row.locked_until), 0, 'and it does not re-lock')
})
