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
 * It also answers tactical questions in prose, which is the one thing here that
 * is not a command: "how do I play against a 4-3-3" wants an answer rather than
 * a rearranged board. That path adds no function and no capability, only
 * context. See `tactics.js` for what it is given to answer from, and the
 * question guard in `src/lib/parser.ts` for what stops the offline half
 * answering the question by setting up the shape it names.
 *
 * Called over HTTP with `fetch` rather than through an SDK: one
 * dependency-free function, no build step.
 */

import { tacticalBrief } from './tactics.js'

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
          description:
            'How high up the pitch the team sits. "high" for a high line or a press, "mid" for a mid block, ' +
            '"default" for a low or deep block, which is also the deepest of the three. There is no "low" value: ' +
            'a coach asking for a low block wants "default".',
        },
      },
      required: ['side', 'name', 'block'],
    },
  },
  {
    name: 'setBlock',
    description:
      'Move a team higher or deeper while keeping its current shape. Use when the coach names a depth and no formation.',
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['home', 'away'] },
        block: {
          type: 'STRING',
          enum: ['default', 'mid', 'high'],
          description: '"high" for a high line or press, "mid" for a mid block, "default" for a low or deep block.',
        },
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

// Takes the message as well as the context because the tactical notes are
// chosen from what was asked, not only from what is drawn: "how do I beat a
// 5-4-1" deserves the 5-4-1 note whether or not anybody has set one up.
const systemPrompt = (message, context) =>
  [
    'You are the assistant inside FootyBoard, a soccer tactics board.',
    'A coach types instructions; you either call exactly one function to act on the board, or answer in prose.',
    '',
    'Call a function when the coach wants the board changed. Answer in prose when they ask a tactical question,',
    'want an explanation, or want something the functions cannot do. In that case say briefly what you can do instead.',
    'Never claim to have changed the board unless you called a function.',
    '',
    // The tactical answer is the one reply that is worth more than a sentence,
    // and the one most likely to come back as a bulleted handout. `clean()`
    // collapses every run of whitespace, so a list arrives as one line with
    // stray hyphens in it; prose is not a preference here, it is the only shape
    // the panel can render.
    'When the coach asks how to play with or against a shape, answer the question and leave the board alone.',
    'Name the space that opens, who gets into it, and what to do about it. Two to four sentences, plain prose:',
    'no bullet points, no numbered lists, no headings. If they ask for a shape as well as advice, call the function too.',
    '',
    'Otherwise keep replies to one or two sentences. Write like a coach talking to a coach: plain, specific, no preamble.',
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
    // Read from the message first and the board second, so a question about a
    // shape nobody has set up yet still gets its note. Empty for the ordinary
    // instruction, which names no shape and should not pay for a paragraph.
    prefixed(tacticalBrief(message, context.board)),
  ].join('\n')

/** A block of context, or nothing at all when there is none. */
const prefixed = (block) => (block ? `\n${block}` : '')

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
 * Why the provider said no, in a form that cannot be the coach's board.
 *
 * This used to be the first 200 characters of the response body, and
 * `routes/assistant.js` logs `err.message`. What the body of a provider error
 * contains is the provider's opinion of the request that caused it, and they
 * routinely quote the offending field straight back — so a 400 on a malformed
 * request wrote part of the board into the server log. The request carries the
 * formation names and up to 4000 characters of board description, on the one
 * route a coach has to explicitly consent to before anything is sent to Google
 * at all. Logging it back out is not something that consent covers.
 *
 * Dropping the detail entirely would make an outage undebuggable, and "Gemini
 * refused the request (400)" is not enough to tell a dead API key from a
 * revoked one from a quota. So what survives is Google's `status` field, which
 * is a fixed enum — `INVALID_ARGUMENT`, `PERMISSION_DENIED`,
 * `RESOURCE_EXHAUSTED`, `UNAVAILABLE` — and is checked against that shape here
 * rather than trusted to be one. An upstream that put free text in the field
 * would find it dropped, which is the correct direction to fail: the numeric
 * status is already on the line, so the worst case is less detail rather than
 * a leak. `message`, the field that actually holds the quoted request, is never
 * read.
 */
const failureReason = async (response) => {
  const status = await response
    .json()
    .then((body) => body?.error?.status)
    .catch(() => null)

  return typeof status === 'string' && /^[A-Z][A-Z_]{1,40}$/.test(status) ? ` ${status}` : ''
}

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
        systemInstruction: { parts: [{ text: systemPrompt(message, context) }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        tools: [{ functionDeclarations: FUNCTIONS }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        // The visible answer is at most four sentences, so most of this ceiling
        // is headroom rather than budget. It is deliberate: on the 2.5 flash
        // family this cap covers thinking tokens as well as the reply, and a cap
        // sized to the reply can be spent entirely on thinking, which comes back
        // as a 200 with no parts in it. That reads as "the assistant said
        // nothing" rather than as a limit being hit, and it got likelier the
        // moment tactical questions started arriving.
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Gemini refused the request (${response.status}${await failureReason(response)})`)
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
