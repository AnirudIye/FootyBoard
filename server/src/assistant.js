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
 * Called over HTTP with `fetch` rather than through an SDK: one
 * dependency-free function, no build step.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

// One env var to change if the free tier moves to a different model name. The
// default is the rolling alias rather than a pinned version on purpose: this
// used to be `gemini-2.5-flash`, which Google stopped serving to new keys, and
// the symptom was a bare 404 rather than anything that reads as a deprecation.
// An alias moves with the free tier; pin it here only when a specific version
// is actually wanted.
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest'

export const assistantEnabled = () => Boolean(process.env.GEMINI_API_KEY)

/**
 * The named pitch areas a player can be sent to.
 *
 * Copied by hand from `ZONES` in `src/lib/parser.ts`, because this is a server
 * module and that is a frontend one. The drift is in the safe direction the
 * same way the function list is: a zone here that the client does not know maps
 * to no coordinates and moves nobody, and a zone the client knows but that is
 * missing here is simply one the AI cannot ask for.
 */
const ZONES = [
  'left-wing',
  'right-wing',
  'left-halfspace',
  'right-halfspace',
  'center-circle',
  'edge-of-box',
  'penalty-spot',
  'six-yard-box',
  'left-back',
  'right-back',
  'high-line',
  'deep',
]

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
  {
    name: 'movePlayer',
    description:
      'Move one player to a named area of the pitch. Use when the coach names a shirt number and where they want that player, like "push the 9 out to the left wing" or "drop 6 deeper".',
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['home', 'away'], description: 'Which team. Default to the active team if unstated.' },
        number: {
          type: 'INTEGER',
          description: 'The shirt number printed on the chip. Numbers run per team, so 9 exists on both sides.',
        },
        zone: {
          type: 'STRING',
          enum: ZONES,
          description:
            "Where to put that player. Left and right are that team's own left and right as they attack, so they mean opposite touchlines for the two sides. Use high-line and deep for up or down the pitch through the middle.",
        },
      },
      required: ['side', 'number', 'zone'],
    },
  },
  {
    name: 'benchPlayer',
    description: 'Take a player off the pitch and put them on the bench.',
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['home', 'away'], description: 'Which team. Default to the active team if unstated.' },
        number: { type: 'INTEGER', description: 'The shirt number of the player to take off.' },
      },
      required: ['side', 'number'],
    },
  },
  {
    name: 'returnPlayer',
    description: 'Bring a substitute off the bench and back onto the pitch, at the halfway line in their own half.',
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['home', 'away'], description: 'Which team. Default to the active team if unstated.' },
        number: { type: 'INTEGER', description: 'The shirt number of the substitute to bring on.' },
      },
      required: ['side', 'number'],
    },
  },
]

/**
 * Take the model's arguments through the declaration that offered them.
 *
 * Returns the validated arguments, or null if the call does not fit its own
 * schema. Checking the function name is only half the boundary this file claims
 * to be: `movePlayer` with a zone nobody declared is as much a capability we
 * never offered as a function nobody declared, and unlike a bad name it does not
 * fail anywhere visible. The client looks the zone up in a table, gets
 * undefined, and writes NaN coordinates that `JSON.stringify` turns into null,
 * so the chip is broadcast to every peer and autosaved with no position at all;
 * on the away side the same input throws inside `mirror` instead, so one team
 * corrupts silently and the other fails loudly on identical input.
 *
 * Only declared keys survive, so an argument the schema never mentioned cannot
 * ride along into the command either.
 */
const checkArgs = (declaration, raw) => {
  const args = {}

  for (const [key, spec] of Object.entries(declaration.parameters.properties ?? {})) {
    let value = raw[key]
    if (value === undefined) continue
    // Shirt numbers are declared INTEGER and normally come back as JSON numbers,
    // but ask for one inside a sentence and a model will occasionally answer "9".
    // The board looks players up with ===, so a string would report no such
    // player rather than move them, which reads as a bug in the board.
    if (spec.type === 'INTEGER') value = Number(value)

    const ok = spec.enum
      ? spec.enum.includes(value)
      : spec.type === 'INTEGER'
        ? Number.isInteger(value)
        : typeof value === 'string'
    if (!ok) return null

    args[key] = value
  }

  // A required argument the model left out is the same problem arriving by the
  // other door: `movePlayer` with no zone reaches the client and moves nobody.
  return (declaration.parameters.required ?? []).every((key) => args[key] !== undefined) ? args : null
}

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
    // The board description is deliberately coordinate-free and names no shirt
    // numbers, so a coach saying "push the striker wide" gives the model nothing
    // to resolve. The numbering is conventional and the formations honour it, so
    // stating the convention is enough to turn a role back into a number. When
    // the guess is wrong the client says which number it could not find rather
    // than moving somebody else.
    'Shirt numbers follow the usual convention: 1 keeper, 2 and 3 full-backs, 4 and 5 centre-backs,',
    '6 holding midfield, 8 central midfield, 10 playmaker, 7 and 11 wide, 9 the striker.',
    'Substitutes are numbered from 12 up. Translate a role the coach names into that number.',
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

  // Re-checked against the declaration rather than trusted, name and arguments
  // both: either one outside what we published would reach the client's executor
  // as something we never offered.
  const declaration = FUNCTIONS.find((f) => f.name === call.name)
  const args = declaration && checkArgs(declaration, call.args ?? {})
  if (!args) {
    return { reply: text || "I can't do that one.", command: null }
  }

  return {
    reply: text || null,
    command: { type: call.name, ...args },
  }
}
