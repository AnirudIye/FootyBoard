import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { TACTICS, formationCodes, tacticalBrief } from './tactics.js'

/**
 * The notes are a second copy of a list that lives in the frontend, and this is
 * what stops that mattering.
 *
 * `ZONES` in `assistant.js` is copied by hand too, and there the drift is safe
 * in both directions: a zone the client does not know moves nobody, and a zone
 * missing from the server is one the AI cannot ask for. Here it is not. A
 * formation the board offers with no note is silent: the coach asks about a
 * shape that is right there in the formation menu, the prompt carries nothing,
 * and the model answers from recall with nobody told it did. So the list is read
 * out of `formations.ts` rather than typed a second time, in the same way
 * `envExample.test.js` reads `.env.example`.
 */

const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/** The formation names `src/lib/formations.ts` actually ships, read as text. */
async function shippedFormations() {
  const source = await read('../../src/lib/formations.ts')
  const block = source.match(/export const FORMATION_NAMES[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(
    block,
    'FORMATION_NAMES is no longer a single object literal in src/lib/formations.ts, so this ' +
      'test cannot see which shapes the board offers. Fix the pattern rather than deleting the test.',
  )

  // Digits joined by dashes, which is a formation code and not one of the keys
  // ('11', '7aside', 'futsal') the same object literal is indexed by.
  const names = [...block[1].matchAll(/'(\d(?:-\d)+)'/g)].map((m) => m[1])
  assert.ok(names.length > 0, 'no formation names found in FORMATION_NAMES')
  return names
}

test('every shape the board offers has a note', async () => {
  const missing = (await shippedFormations()).filter((name) => !(name in TACTICS))

  assert.deepEqual(
    missing,
    [],
    `these formations are in the board's menu with nothing written down about them: ${missing.join(', ')}. ` +
      'A coach asking about one gets whatever the model happens to remember.',
  )
})

test('no note describes a shape the board cannot set up', async () => {
  // The other direction is only tidiness rather than a hole, but a note for a
  // shape nobody can put on the pitch is a note nobody will ever read, and it
  // still costs prompt space every time its digits appear in a message.
  const shipped = new Set(await shippedFormations())
  const orphans = Object.keys(TACTICS).filter((code) => !shipped.has(code))

  assert.deepEqual(orphans, [], `notes for shapes with no preset: ${orphans.join(', ')}`)
})

test('every note is complete', () => {
  for (const [code, brief] of Object.entries(TACTICS)) {
    assert.equal(typeof brief.identity, 'string', code)
    assert.ok(brief.identity.length > 20, `${code} has no real identity line`)
    for (const key of ['strengths', 'weaknesses', 'against', 'using']) {
      assert.ok(Array.isArray(brief[key]) && brief[key].length >= 2, `${code}.${key} is thin or missing`)
      for (const line of brief[key]) assert.ok(line.trim().length > 0, `${code}.${key} has an empty line`)
    }
  }
})

test('no note carries an em dash into the prompt', () => {
  // The house rule covers anything a user reads, and every sentence here is
  // written to be quoted back at a coach. `clean()` catches what the model
  // writes; nothing catches what we feed it, so a dash in here is a dash the
  // model is being shown as house style.
  const all = JSON.stringify(TACTICS)
  assert.equal(all.includes('—'), false, 'an em dash is in the tactical notes')
  assert.equal(all.includes('–'), false, 'an en dash is in the tactical notes')
})

test('a formation code is found however it is spelled', () => {
  assert.deepEqual(formationCodes('how do i beat a 4-2-3-1'), ['4-2-3-1'])
  assert.deepEqual(formationCodes('4231 is what they play'), ['4-2-3-1'])
  assert.deepEqual(formationCodes('they line up 4 3 3'), ['4-3-3'])
})

test('a code is only a code when there is a note for it', () => {
  // This runs over a coach's free text, so a shirt number, a scoreline or a
  // date must not become a lookup. Filtering to what we have written down is
  // what makes that safe rather than a parsing problem.
  assert.deepEqual(formationCodes('move 9 to the left wing'), [])
  assert.deepEqual(formationCodes('set up a 9-1-0'), [])
  assert.deepEqual(formationCodes('we won 3-2-1 on aggregate somehow'), [])
})

test('the same shape twice is one shape', () => {
  assert.deepEqual(formationCodes('a 4-3-3 against another 4-3-3'), ['4-3-3'])
})

test('the shape asked about comes before the shapes on the board', () => {
  // The cap is three, and a coach who names a shape is asking about that one.
  // Reading the board first would let two shapes they did not mention push the
  // one they did out of the prompt.
  const brief = tacticalBrief('how do i beat a 5-4-1', 'Home are in a 4-3-3. Away are in a 4-4-2.')

  assert.match(brief, /^5-4-1:/m)
  assert.match(brief, /^4-3-3:/m)
  assert.match(brief, /^4-4-2:/m)
})

test('no more than three shapes are ever sent', () => {
  const brief = tacticalBrief('4-3-3 4-4-2 4-2-3-1 3-5-2 5-3-2 3-4-3')
  const headings = [...brief.matchAll(/^[\d-]+:/gm)]

  assert.equal(headings.length, 3)
})

test('a message about no shape at all costs nothing', () => {
  assert.equal(tacticalBrief('clear the arrows', 'This is an 11-a-side board.'), '')
  assert.equal(tacticalBrief(undefined, null), '')
})

test('a note carries all four of its sections', () => {
  const brief = tacticalBrief('what beats a 3-5-2')

  assert.match(brief, /Strengths:/)
  assert.match(brief, /Weaknesses:/)
  assert.match(brief, /Playing against it:/)
  assert.match(brief, /Getting the best out of it:/)
  assert.match(brief, /wing-backs/, 'the note should be about the shape it names')
})
