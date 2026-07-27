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
    'clearDrawings',
    'fit',
    'play',
    'readBoard',
    'resetBoard',
    'setBlock',
    'setFormation',
    'setView',
    'toggleGrid',
  ])
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
