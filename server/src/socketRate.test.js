import test from 'node:test'
import assert from 'node:assert/strict'
import { withinRate } from './realtime.js'

/**
 * The per-socket token bucket. Pure arithmetic on a plain object, so `now` is
 * passed in rather than slept through: a test that waited for real refills
 * would take seconds to prove something the clock does not actually decide.
 *
 * The numbers under test are a burst of 240 and a refill of 120 a second.
 */

/** A stand-in for the socket, which the bucket only ever hangs two fields on. */
const socket = () => ({})

test('a fresh socket can spend the whole burst at once', () => {
  const s = socket()
  for (let i = 0; i < 240; i++) {
    assert.equal(withinRate(s, 1000), true, `message ${i + 1} of the burst was dropped`)
  }
})

test('the burst is a ceiling, not a suggestion', () => {
  const s = socket()
  for (let i = 0; i < 240; i++) withinRate(s, 1000)
  assert.equal(withinRate(s, 1000), false, 'a message past the burst got through')
})

test('tokens come back at a hundred and twenty a second', () => {
  const s = socket()
  for (let i = 0; i < 240; i++) withinRate(s, 1000)
  assert.equal(withinRate(s, 1000), false)

  // Half a second later, sixty tokens are back.
  for (let i = 0; i < 60; i++) {
    assert.equal(withinRate(s, 1500), true, `refilled token ${i + 1} was not honoured`)
  }
  assert.equal(withinRate(s, 1500), false, 'refill overshot the elapsed time')
})

test('an idle socket does not bank an unbounded burst', () => {
  const s = socket()
  withinRate(s, 1000)

  // An hour of silence still buys exactly one burst, not 432,000 tokens.
  let sent = 0
  while (withinRate(s, 1000 + 60 * 60 * 1000)) sent++
  assert.equal(sent, 240, 'an idle socket banked more than one burst')
})

test('a busy but legitimate client never trips it', () => {
  // connection.ts coalesces to one message per throttle key per 50ms, so even
  // several live keys during a drag sit near eighty a second — above the shape
  // a real drag produces, and well inside what the throttle permits. Sustain
  // that for a minute and nothing should be dropped. This is the case that
  // caught the first draft, which refilled at sixty.
  const s = socket()
  let dropped = 0
  for (let ms = 0; ms < 60_000; ms += 1000) {
    for (let i = 0; i < 80; i++) {
      if (!withinRate(s, ms + (i * 1000) / 80)) dropped++
    }
  }
  assert.equal(dropped, 0, `${dropped} legitimate messages were dropped`)
})

test('a flooder is capped near the refill rate', () => {
  // Ten thousand messages shoved in over ten seconds: the bucket lets through
  // the burst plus ten seconds of refill, and no more.
  const s = socket()
  let sent = 0
  for (let i = 0; i < 10_000; i++) {
    if (withinRate(s, (i * 10_000) / 10_000)) sent++
  }
  assert.ok(sent <= 240 + 120 * 10 + 1, `a flood got ${sent} through, which is above the ceiling`)
  assert.ok(sent < 10_000, 'the flood was not limited at all')
})
