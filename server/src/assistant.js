/**
 * The assistant's optional AI half.
 *
 * The board's assistant is, and stays, a deterministic rule-based parser. This
 * module is only reached when that parser does not recognise what was typed —
 * so an install with no API key behaves exactly as it always has, offline and
 * free, and the AI is a fallback for the phrasings nobody thought to enumerate.
 *
 * **The model never touches the board.** It picks from a fixed list of function
 * declarations that mirror the parser's own command union one for one, and the
 * client runs the result through the same `execute()` the parser feeds. So the
 * schema below *is* the capability boundary: the AI can ask for a formation or
 * a view change, and there is no shape in which it can ask for anything else.
 *
 * Called over HTTP with `fetch` rather than through an SDK, matching how
 * `mailer.js` talks to Resend — one dependency-free function, no build step.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

// One env var to change if the free tier moves to a different model name.
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

export const assistantEnabled = () => Boolean(process.env.GEMINI_API_KEY)

/**
 * Every action the assistant may take, as OpenAPI-shaped declarations.
 *
 * These mirror `src/lib/parser.ts`'s `Command` union exactly. If a command is
 * added there and not here the AI simply cannot reach it, which is the safe
 * direction for the two to drift.
 */
const FUNCTIONS = [
  {
    name: 'setFormation',
    description:
      "Arrange a team into a named formation. Use when the user names a shape like 4-3-3, a 'high press', or asks to line a team up.",
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['home', 'away'], description: 'Which team. Default to the active team if unstated.' },
        name: { type: 'STRING', description: 'Formation name exactly as listed in the available formations.' },
        block: {
          type: 'STRING',
          enum: ['default', 'mid', 'high'],
          description: 'How high the team sits. "high" for a press, "mid" for a mid block, otherwise "default".',
        },
      },
      required: ['side', 'name', 'block'],
    },
  },
  {
    name: 'setBlock',
    description: 'Move a team higher or deeper while keeping its current shape.',
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['home', 'away'] },
        block: { type: 'STRING', enum: ['default', 'mid', 'high'] },
      },
      required: ['side', 'block'],
    },
  },
  {
    name: 'setView',
    description: 'Change which part of the pitch is shown.',
    parameters: {
      type: 'OBJECT',
      properties: {
        view: {
          type: 'STRING',
          enum: ['fullH', 'fullV', 'attackHalf', 'defendHalf', 'blank'],
          description:
            'fullH is the whole pitch across, fullV the whole pitch upright, attackHalf and defendHalf the halves, blank an empty surface.',
        },
      },
      required: ['view'],
    },
  },
  { name: 'clearDrawings', description: 'Remove every annotation, leaving the players in place.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'resetBoard', description: 'Return the whole board to its starting state. Undoable.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'toggleGrid', description: 'Turn the channels-and-thirds overlay on or off.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'addFrame', description: 'Capture the current positions as a frame in the sequence.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'play', description: 'Play the captured frames as an animation.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'fit', description: 'Fit the pitch back into view.', parameters: { type: 'OBJECT', properties: {} } },
  {
    name: 'readBoard',
    description: 'Describe what is currently on the board. Use when asked what the board shows rather than to change it.',
    parameters: { type: 'OBJECT', properties: {} },
  },
]

const systemPrompt = (context) =>
  [
    'You are the assistant inside FootyBoard, a soccer tactics board.',
    'A coach types instructions; you either call exactly one function to act on the board, or answer in prose.',
    '',
    'Call a function when the coach wants the board changed. Answer in prose when they ask a tactical question,',
    'want an explanation, or want something the functions cannot do. In that case say briefly what you can do instead.',
    'Never claim to have changed the board unless you called a function.',
    '',
    'Keep replies to one or two sentences. Write like a coach talking to a coach: plain, specific, no preamble.',
    'Never use em dashes. Use a full stop, a comma, or a colon instead.',
    '',
    `Formations available on this pitch: ${context.formationNames.join(', ')}.`,
    `Pitch format: ${context.kind}. Active team: ${context.activeTeam}.`,
    context.board ? `\nWhat is on the board right now:\n${context.board}` : '',
  ].join('\n')

/**
 * House style, enforced rather than requested.
 *
 * The prompt asks for no em dashes, but a prompt is a preference and this is a
 * rule about what the product says. An em dash between clauses becomes a full
 * stop; one used parenthetically becomes a comma.
 */
const clean = (text) =>
  text
    .replace(/\s*—\s*/g, (match, offset, whole) => {
      const rest = whole.slice(offset + match.length)
      return /^[a-z]/.test(rest) ? ', ' : '. '
    })
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Ask the model what to do. Returns `{ reply, command }`, where `command` is
 * either null or one of the parser's own command objects.
 *
 * Throws on transport or API failure so the caller can decide what the coach
 * sees; it deliberately does not invent a fallback reply, because "I didn't
 * understand" and "the AI is down" are different things and should read
 * differently.
 */
export async function askAssistant(message, context) {
  const response = await fetch(
    `${ENDPOINT}/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(context) }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        tools: [{ functionDeclarations: FUNCTIONS }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
      }),
    },
  )

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Gemini refused the request (${response.status}) ${detail.slice(0, 200)}`)
  }

  const body = await response.json()
  const parts = body?.candidates?.[0]?.content?.parts ?? []

  const call = parts.find((p) => p.functionCall)?.functionCall
  const text = clean(
    parts
      .map((p) => p.text)
      .filter(Boolean)
      .join(' '),
  )

  if (!call) {
    return { reply: text || "I'm not sure what to do with that one.", command: null }
  }

  // Re-checked against the declared list rather than trusted: a name outside it
  // would reach the client's executor as an unknown command.
  if (!FUNCTIONS.some((f) => f.name === call.name)) {
    return { reply: text || "I can't do that one.", command: null }
  }

  return {
    reply: text || null,
    command: { type: call.name, ...(call.args ?? {}) },
  }
}
