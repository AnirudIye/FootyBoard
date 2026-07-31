import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { askAssistant, assistantEnabled } from './assistant.js'

/**
 * The model picks from a fixed list of functions and the client runs the result
 * through the same executor the offline parser feeds. These tests cover the
 * seam: what we send, and what we are willing to hand back.
 *
 * `fetch` is stubbed rather than called — the point is our translation layer,
 * not Google's.
 */

const realFetch = globalThis.fetch
let lastRequest = null

const stubGemini = (parts, { ok = true, status = 200 } = {}) => {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), body: JSON.parse(init.body) }
    return {
      ok,
      status,
      json: async () => ({ candidates: [{ content: { parts } }] }),
      text: async () => 'error body',
    }
  }
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key'
  lastRequest = null
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.GEMINI_API_KEY
})

const context = {
  formationNames: ['4-3-3', '4-4-2'],
  kind: '11',
  activeTeam: 'home',
  board: 'Home in a 4-3-3.',
}

test('the assistant is off until a key is configured', () => {
  delete process.env.GEMINI_API_KEY
  assert.equal(assistantEnabled(), false)
  process.env.GEMINI_API_KEY = 'test-key'
  assert.equal(assistantEnabled(), true)
})

test('a function call becomes a command the board executor understands', async () => {
  stubGemini([{ functionCall: { name: 'setFormation', args: { side: 'away', name: '4-4-2', block: 'high' } } }])

  const result = await askAssistant('press them high with a flat four four two', context)
  assert.deepEqual(result.command, {
    type: 'setFormation',
    side: 'away',
    name: '4-4-2',
    block: 'high',
  })
})

test('prose with no function call is passed through as an answer', async () => {
  stubGemini([{ text: 'A mid block invites pressure but protects the space behind.' }])

  const result = await askAssistant('what does a mid block do', context)
  assert.equal(result.command, null)
  assert.match(result.reply, /mid block/)
})

test('a function outside the declared list is refused, not forwarded', async () => {
  // The declared functions are the capability boundary. A name we never
  // published has no business reaching the client's executor, whatever the
  // model had in mind.
  stubGemini([{ functionCall: { name: 'deleteEverything', args: {} } }])

  const result = await askAssistant('wipe it', context)
  assert.equal(result.command, null)
})

test('the board and the real formation names are sent as context', async () => {
  stubGemini([{ text: 'ok' }])
  await askAssistant('hello', context)

  const system = lastRequest.body.systemInstruction.parts[0].text
  assert.match(system, /4-3-3, 4-4-2/, 'the model is told which formations exist')
  assert.match(system, /Home in a 4-3-3\./, 'and what is currently on the board')
  assert.match(system, /Active team: home/)
})

test('only the declared functions are offered', async () => {
  stubGemini([{ text: 'ok' }])
  await askAssistant('hello', context)

  const names = lastRequest.body.tools[0].functionDeclarations.map((f) => f.name).sort()
  assert.deepEqual(names, [
    'addFrame',
    'benchPlayer',
    'clearDrawings',
    'fit',
    'movePlayer',
    'play',
    'readBoard',
    'resetBoard',
    'returnPlayer',
    'setBlock',
    'setFormation',
    'setView',
    'toggleGrid',
  ])
})

test('every declaration stays inside the OpenAPI subset Gemini accepts', async () => {
  // A schema Gemini rejects fails the whole call, not just the one function, so
  // the whole assistant goes down for a typo in a property type.
  stubGemini([{ text: 'ok' }])
  await askAssistant('hello', context)

  const allowed = new Set(['STRING', 'INTEGER'])
  for (const fn of lastRequest.body.tools[0].functionDeclarations) {
    assert.equal(fn.parameters.type, 'OBJECT', fn.name)
    for (const [key, prop] of Object.entries(fn.parameters.properties)) {
      assert.ok(allowed.has(prop.type), `${fn.name}.${key} is ${prop.type}`)
      if (prop.enum) assert.ok(Array.isArray(prop.enum) && prop.enum.length > 0, `${fn.name}.${key}`)
    }
    for (const key of fn.parameters.required ?? []) {
      assert.ok(key in fn.parameters.properties, `${fn.name} requires undeclared ${key}`)
    }
  }
})

test('a player command carries the shirt number through as a number', async () => {
  stubGemini([{ functionCall: { name: 'movePlayer', args: { side: 'home', number: 9, zone: 'left-wing' } } }])

  const result = await askAssistant('push the nine out wide left', context)
  assert.deepEqual(result.command, { type: 'movePlayer', side: 'home', number: 9, zone: 'left-wing' })
})

test('a shirt number answered as a string is coerced, not passed on', async () => {
  // The board looks players up with ===, so "9" would report no such player
  // rather than move him, and that reads as a bug in the board.
  stubGemini([{ functionCall: { name: 'benchPlayer', args: { side: 'away', number: '4' } } }])

  const result = await askAssistant('take their four off', context)
  assert.deepEqual(result.command, { type: 'benchPlayer', side: 'away', number: 4 })
})

test('the key travels in the query string and never in the prompt', async () => {
  stubGemini([{ text: 'ok' }])
  await askAssistant('hello', context)

  assert.match(lastRequest.url, /key=test-key/)
  assert.equal(JSON.stringify(lastRequest.body).includes('test-key'), false)
})

test('em dashes never reach the coach, whatever the model writes', async () => {
  // The prompt asks for none, but a prompt is a preference. This is a rule
  // about what the product says, so it is enforced on the way out.
  stubGemini([{ text: 'Push the line up — it squeezes the space — and press the first pass.' }])

  const result = await askAssistant('thoughts?', context)
  assert.equal(result.reply.includes('—'), false, result.reply)
  assert.equal(result.reply, 'Push the line up, it squeezes the space, and press the first pass.')
})

test('an em dash before a new sentence becomes a full stop', async () => {
  stubGemini([{ text: 'That shape is risky — Keep a holding player deep.' }])

  const result = await askAssistant('thoughts?', context)
  assert.equal(result.reply, 'That shape is risky. Keep a holding player deep.')
})

test('the shape a coach asks about is described in the prompt', async () => {
  // Without this the model answers "how do I beat a 5-4-1" from recall, about
  // whichever 5-4-1 it happens to hold, rather than about the one this board
  // draws. The note is what makes the answer this product's answer.
  stubGemini([{ text: 'ok' }])
  await askAssistant('how do i beat a 5-4-1', context)

  const system = lastRequest.body.systemInstruction.parts[0].text
  assert.match(system, /^5-4-1:/m)
  assert.match(system, /Playing against it:/)
})

test('a shape only on the board is described too', async () => {
  // "how do I get at them" names nothing, and the board is the only thing that
  // knows what "them" is.
  stubGemini([{ text: 'ok' }])
  await askAssistant('how do i get at them', context)

  const system = lastRequest.body.systemInstruction.parts[0].text
  assert.match(system, /^4-3-3:/m, 'the shape described on the board should carry its note')
})

test('an instruction that names no shape carries no notes', async () => {
  // The notes are roughly a hundred words each, and most messages are
  // instructions. They should not pay for a paragraph they will never use.
  stubGemini([{ text: 'ok' }])
  await askAssistant('clear the arrows', { ...context, board: 'This is an 11-a-side board.' })

  const system = lastRequest.body.systemInstruction.parts[0].text
  assert.equal(/Playing against it:/.test(system), false)
})

test('the prompt says to answer a tactical question rather than act on it', async () => {
  // The model can still call a function, so nothing but this sentence stops it
  // answering "how do I play against a 4-3-3" by setting one up, which is the
  // exact failure the offline parser had.
  stubGemini([{ text: 'ok' }])
  await askAssistant('hello', context)

  const system = lastRequest.body.systemInstruction.parts[0].text
  assert.match(system, /leave the board alone/)
  assert.match(system, /no bullet points/, 'a list arrives as one mangled line once clean() runs')
})

test('a tactical answer of several sentences survives intact', async () => {
  // The one reply worth more than a sentence. `clean()` collapses whitespace,
  // so what has to be checked is that it collapses rather than truncates.
  stubGemini([
    {
      text:
        'Their holder is alone in front of the back four.\nPut your 10 either side of him and make a centre-back step out.\n' +
        'When the full-backs push on, the space behind them is where the game is.',
    },
  ])

  const result = await askAssistant('how do i beat a 4-3-3', context)
  assert.equal(result.command, null)
  assert.match(result.reply, /holder is alone/)
  assert.match(result.reply, /space behind them/)
  assert.equal(result.reply.includes('\n'), false)
})

test('the answer has room to be written', async () => {
  // Advice runs to four sentences, and on this model family the cap covers
  // thinking tokens as well as the reply. A cap sized to the visible answer can
  // be spent entirely on thinking and come back empty.
  stubGemini([{ text: 'ok' }])
  await askAssistant('hello', context)

  assert.ok(lastRequest.body.generationConfig.maxOutputTokens >= 1024)
})

test('a provider failure throws rather than inventing an answer', async () => {
  // "I did not understand you" and "the AI is down" are different things, and
  // the coach should not be told the first when the second happened.
  stubGemini([], { ok: false, status: 429 })
  await assert.rejects(() => askAssistant('hello', context), /429/)
})

test('an empty response still yields something to say', async () => {
  stubGemini([])
  const result = await askAssistant('hello', context)
  assert.equal(result.command, null)
  assert.ok(result.reply.length > 0)
})
