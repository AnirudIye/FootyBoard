import test from 'node:test'
import assert from 'node:assert/strict'
import { generateCode, normalizeCode, CODE_LENGTH } from './joinCode.js'

/**
 * The code has to survive being read off a screen and typed by someone else.
 * Most of these are about that, not about cryptography.
 */

test('codes are the advertised length and letters only', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode()
    assert.equal(code.length, CODE_LENGTH)
    assert.match(code, /^[A-Z]+$/)
  }
})

test('codes never contain the letters people read as digits', () => {
  // I and O are read as 1 and 0 even when there are no digits on screen.
  for (let i = 0; i < 500; i++) {
    const code = generateCode()
    assert.ok(!code.includes('I'), `generated ${code}`)
    assert.ok(!code.includes('O'), `generated ${code}`)
  }
})

test('codes vary', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(generateCode())
  assert.ok(seen.size > 190, `only ${seen.size} distinct codes in 200 draws`)
})

test('a generated code always survives a round trip through normalize', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode()
    assert.equal(normalizeCode(code), code)
  }
})

test('how someone actually types it does not matter', () => {
  assert.equal(normalizeCode('abcdef'), 'ABCDEF')
  assert.equal(normalizeCode('ABC DEF'), 'ABCDEF')
  assert.equal(normalizeCode('abc-def'), 'ABCDEF')
  assert.equal(normalizeCode('  A B C D E F  '), 'ABCDEF')
})

test('anything that is not a code is refused rather than guessed at', () => {
  assert.equal(normalizeCode('ABCDE'), null, 'too short')
  assert.equal(normalizeCode('ABCDEFG'), null, 'too long')
  assert.equal(normalizeCode(''), null)
  assert.equal(normalizeCode(null), null)
  assert.equal(normalizeCode(undefined), null)
  assert.equal(normalizeCode(123456), null, 'not a string')
  assert.equal(normalizeCode('ABC123'), null, 'digits are not in the alphabet')
})

test('an ambiguous character is refused, not silently corrected', () => {
  // A typed O could be an O or a zero, and neither is in the alphabet. Guessing
  // would risk admitting someone to a different board than the one they meant.
  assert.equal(normalizeCode('ABCDEO'), null)
  assert.equal(normalizeCode('ABCDEI'), null)
  assert.equal(normalizeCode('ABCDE0'), null)
  assert.equal(normalizeCode('ABCDE1'), null)
})
