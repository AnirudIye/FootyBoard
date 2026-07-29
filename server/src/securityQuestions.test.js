import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { closePool } from './db.js'
import {
  SECURITY_QUESTIONS,
  isKnownQuestion,
  normalizeAnswer,
  hashAnswer,
  verifyAnswer,
  validateSecurityQuestionId,
  validateSecurityAnswer,
  derivedQuestionId,
  questionFor,
  DECOY_ANSWER,
} from './securityQuestions.js'

/**
 * The question itself, without a server in front of it.
 *
 * The property worth the most here is the dullest one: that the normalisation
 * applied when an answer is stored is the same normalisation applied when it is
 * checked. If those two ever part company nobody can recover an account, and
 * nothing anywhere says so. It is one function with exactly two callers, and
 * these tests exercise it through both of them rather than directly, because
 * calling it directly would pass even if `hashAnswer` had stopped using it.
 */

after(() => closePool())

test('the same answer typed differently still verifies', async () => {
  const { hash, salt } = await hashAnswer(' Blue  Sky ')

  assert.equal(await verifyAnswer('blue sky', salt, hash), true)
  assert.equal(await verifyAnswer('BLUE SKY', salt, hash), true)
  assert.equal(await verifyAnswer('  blue   sky  ', salt, hash), true)
  assert.equal(await verifyAnswer('Blue Sky', salt, hash), true)

  // And the other direction, since either path could be the one that drifted.
  const other = await hashAnswer('blue sky')
  assert.equal(await verifyAnswer(' Blue  Sky ', other.salt, other.hash), true)
})

test('a different answer does not verify', async () => {
  const { hash, salt } = await hashAnswer('Blue Sky')

  for (const wrong of ['blue skies', 'bluesky', 'red sky', 'blue', '']) {
    assert.equal(await verifyAnswer(wrong, salt, hash), false, `"${wrong}" was accepted`)
  }
})

test('collapsing whitespace does not join separate words', async () => {
  // "bluesky" and "blue sky" are different answers. Collapsing runs must not
  // become stripping, which would quietly make them the same one.
  assert.equal(normalizeAnswer('blue sky'), 'blue sky')
  assert.equal(normalizeAnswer('bluesky'), 'bluesky')
  assert.notEqual(normalizeAnswer('blue sky'), normalizeAnswer('bluesky'))
})

test('nothing readable is kept: the digest is not the answer', async () => {
  const answer = 'Kevin Keegan'
  const { hash, salt } = await hashAnswer(answer)

  const stored = `${hash} ${salt}`.toLowerCase()
  assert.ok(!stored.includes('kevin'), 'the answer survived into what is stored')
  assert.ok(!stored.includes('keegan'))
  assert.equal(hash.length, 128, 'a 64-byte scrypt digest, hex encoded')

  // Two accounts with the same answer must not share a digest, or the table
  // would say which of them answered alike.
  const again = await hashAnswer(answer)
  assert.notEqual(again.salt, salt)
  assert.notEqual(again.hash, hash)
})

test('the decoy never matches, and costs the same work', async () => {
  assert.equal(await verifyAnswer('anything at all', DECOY_ANSWER.salt, DECOY_ANSWER.hash), false)
  assert.equal(await verifyAnswer('', DECOY_ANSWER.salt, DECOY_ANSWER.hash), false)
})

test('a question id has to be one of ours', () => {
  for (const q of SECURITY_QUESTIONS) assert.equal(validateSecurityQuestionId(q.id), q.id)

  for (const bad of ['', 'not-a-question', 'FIRST-PET', null, 7, undefined]) {
    assert.throws(() => validateSecurityQuestionId(bad), { field: 'securityQuestionId' })
  }
})

test('an answer is judged after normalisation, not before', () => {
  assert.throws(() => validateSecurityAnswer('  a  '), { field: 'securityAnswer' })
  assert.throws(() => validateSecurityAnswer('      '), { field: 'securityAnswer' })
  assert.throws(() => validateSecurityAnswer(null), { field: 'securityAnswer' })

  // Three characters once the padding is gone is three characters.
  assert.equal(validateSecurityAnswer('  cat  '), '  cat  ')
})

test('an address with no account still gets a stable question from the list', () => {
  const address = 'nobody-at-all@test.invalid'

  const first = derivedQuestionId(address)
  assert.ok(isKnownQuestion(first), 'the derived question is a real one')
  assert.equal(derivedQuestionId(address), first, 'and asking again does not change its mind')

  // Different addresses land in different places often enough to be a mapping
  // rather than a constant.
  const spread = new Set(
    Array.from({ length: 60 }, (_, i) => derivedQuestionId(`probe-${i}@test.invalid`)),
  )
  assert.ok(spread.size > 1, 'every address got the same question')
})

test('a stored question that is no longer on the list falls back rather than returning nothing', () => {
  const address = 'someone@test.invalid'

  assert.equal(questionFor(address, 'first-pet').id, 'first-pet')
  // A null here would be the enumeration leak wearing a different hat.
  assert.equal(questionFor(address, 'retired-question').id, derivedQuestionId(address))
  assert.equal(questionFor(address, null).id, derivedQuestionId(address))
  assert.ok(questionFor(address, null).label)
})

test('no question text carries an em dash', () => {
  for (const q of SECURITY_QUESTIONS) {
    assert.ok(!q.label.includes('—'), `${q.id} has an em dash`)
    assert.ok(q.label.endsWith('?'), `${q.id} is not phrased as a question`)
  }
  assert.ok(SECURITY_QUESTIONS.length >= 8, 'too few to choose from')
  assert.equal(new Set(SECURITY_QUESTIONS.map((q) => q.id)).size, SECURITY_QUESTIONS.length)
})
