import type { Side, PitchView, PitchKind } from './types'
import type { BlockHeight, Pos } from './formations'
import { formationCode, mirror } from './formations'

/**
 * Named areas of the pitch, in the words a coach would use rather than
 * coordinates.
 *
 * A closed list rather than free text because it is also the vocabulary offered
 * to the AI fallback, and an enum is the difference between "put him wherever
 * you like" and a fixed set of places we have chosen. Left and right belong to
 * the team being moved, so the same word means opposite touchlines for the two
 * sides.
 */
export const ZONES = [
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
] as const

export type Zone = (typeof ZONES)[number]

export type Command =
  | { type: 'setFormation'; side: Side; name: string; block: BlockHeight }
  | { type: 'setBlock'; side: Side; block: BlockHeight }
  | { type: 'clearDrawings' }
  | { type: 'resetBoard' }
  | { type: 'setView'; view: PitchView }
  | { type: 'toggleGrid' }
  | { type: 'addFrame' }
  | { type: 'play' }
  | { type: 'fit' }
  | { type: 'readBoard' }
  | { type: 'movePlayer'; side: Side; number: number; zone: Zone }
  | { type: 'benchPlayer'; side: Side; number: number }
  | { type: 'returnPlayer'; side: Side; number: number }

/**
 * Every zone as a point in home orientation, in the same 0-100 normalized space
 * the board store keeps tokens in: x runs from the team's own goal line at 0 to
 * the opponent's at 100, y from the top touchline at 0 to the bottom at 100.
 *
 * The three box figures are the real pitch rather than a guess, so a chip put on
 * the penalty spot lands on the penalty spot the pitch layer draws: on a 105m
 * pitch the penalty area is 16.5m deep (edge at 84), the spot 11m out (89.5),
 * the six-yard line 5.5m (94.5).
 */
const ZONE_POSITIONS: Record<Zone, Pos> = {
  'left-wing': { x: 70, y: 12 },
  'right-wing': { x: 70, y: 88 },
  'left-halfspace': { x: 68, y: 30 },
  'right-halfspace': { x: 68, y: 70 },
  'center-circle': { x: 50, y: 50 },
  'edge-of-box': { x: 84, y: 50 },
  'penalty-spot': { x: 89.5, y: 50 },
  'six-yard-box': { x: 94.5, y: 50 },
  'left-back': { x: 22, y: 18 },
  'right-back': { x: 22, y: 82 },
  'high-line': { x: 60, y: 50 },
  deep: { x: 18, y: 50 },
}

/**
 * Where a zone is for a given team.
 *
 * Away attacks the other way, and `mirror` is the same half-turn the formations
 * take, so this reuses it rather than flipping x by hand: a half-turn is what
 * puts "left wing" on that team's own left instead of on the home team's.
 */
export const zonePosition = (zone: Zone, side: Side): Pos =>
  side === 'away' ? mirror([ZONE_POSITIONS[zone]])[0] : { ...ZONE_POSITIONS[zone] }

export interface ParseContext {
  formationNames: string[]
  kind: PitchKind
  /** Team to act on when the message names none. Defaults to home. */
  defaultSide?: Side
}

export interface ParseResult {
  command: Command | null
  reply: string
  /**
   * True when the message asked about the game rather than instructing the
   * board, so there was never a command to find and `reply` is standing in for
   * an answer the offline half cannot give.
   *
   * Carried because the two ways of having no command need different words when
   * the AI is reachable but the network is not: "I didn't understand that" is
   * wrong for a question, and "turn the online assistant on" is wrong for
   * somebody who already has. `runAssistant` is the only caller that can tell
   * those apart, because only it knows whether the AI was switched on.
   */
  asking?: boolean
}

const BLOCK_LABEL: Record<BlockHeight, string> = {
  default: 'deep block',
  mid: 'mid block',
  high: 'high line',
}

const ZONE_LABEL: Record<Zone, string> = {
  'left-wing': 'the left wing',
  'right-wing': 'the right wing',
  'left-halfspace': 'the left half-space',
  'right-halfspace': 'the right half-space',
  'center-circle': 'the centre circle',
  'edge-of-box': 'the edge of the box',
  'penalty-spot': 'the penalty spot',
  'six-yard-box': 'the six-yard box',
  'left-back': 'left back',
  'right-back': 'right back',
  'high-line': 'the high line',
  deep: 'a deep position',
}

// The phrasings that name a zone, checked in order and first match wins. The
// order matters at the bottom of the list rather than the top: "deep" is the
// loosest of them and would otherwise swallow a message that also names a
// specific place, so it goes last.
const ZONE_WORDS: [RegExp, Zone][] = [
  [/\bleft[-\s]?backs?\b/, 'left-back'],
  [/\bright[-\s]?backs?\b/, 'right-back'],
  [/\bleft half[-\s]?space\b/, 'left-halfspace'],
  [/\bright half[-\s]?space\b/, 'right-halfspace'],
  [/\bleft (?:wing|flank|touchline)\b/, 'left-wing'],
  [/\bright (?:wing|flank|touchline)\b/, 'right-wing'],
  [/\b(?:cent(?:re|er) circle|middle of the (?:pitch|park))\b/, 'center-circle'],
  [/\b(?:edge of the (?:box|area)|top of the box)\b/, 'edge-of-box'],
  [/\bpenalty spot\b/, 'penalty-spot'],
  [/\bsix[-\s]?yard box\b/, 'six-yard-box'],
  [/\b(?:high line|higher up|up the pitch)\b/, 'high-line'],
  [/\bdeep(?:er)?\b/, 'deep'],
]

const CANT_DO =
  "That one's beyond me. Things I can do: set a formation (\"put the away team in a 4-2-3-1 mid block\"), " +
  'push a team higher or drop them deeper, move one player to a part of the pitch ("move 9 to the left wing"), ' +
  'bench a number or bring one back on, clear the arrows, reset the board, flip the pitch, ' +
  'turn the channels on, take a frame, play the sequence, fit the view, or tell you what I see.'

/**
 * Asking about the game rather than asking for the board to change.
 *
 * This is checked before every command rule, and the reason is a bug rather than
 * a preference. A tactical question almost always contains the exact thing a
 * command rule matches on: "how do I play against a 4-3-3" carries a formation
 * code, and every rule below it needs nothing more than that. So the board used
 * to answer the question by becoming a 4-3-3, which is both the wrong answer and
 * a destructive one, since it moved eleven players the coach had placed.
 *
 * Each cue therefore has to be specific enough that an instruction cannot trip
 * it. A bare "what" would swallow "what do you see", which is a board command;
 * a bare "press" would swallow "4-3-3 high press". Where a phrasing is genuinely
 * both ("how do I set up a 4-3-3"), it goes here: with the online assistant on,
 * the model can still call `setFormation` and does, so nothing is lost, and
 * offline the reply below names the shape it saw so the coach can ask for it in
 * one more word.
 */
const ASKING: RegExp[] = [
  /\bhow (?:do|does|did|can|could|should|would|to)\b/,
  /\b(?:best|worst|right|quickest) way\b/,
  /\bwhat (?:beats?|stops?|works?|formation|shape|sort of|kind of)\b/,
  /\bwhat(?:'s| is| are)? the (?:best|weakness|strength|risk|danger|problem|downside|trade[-\s]?off)/,
  /\bwhy\b/,
  /\bshould (?:i|we|you)\b/,
  /\b(?:advice|advise|tips?|pros and cons)\b/,
  /\b(?:strengths?|weakness(?:es)?|vulnerab\w+)\b/,
  // "playing against a 3-5-2", "set up against them". The trailing word is what
  // keeps these out of "play the animation" and "set up a 4-3-3".
  /\b(?:play|playing|line up|lining up|set up|setting up|defend|defending|attack|attacking|press|pressing|build|building) (?:up )?against\b/,
  // A verb that only makes sense pointed at somebody, so it needs an object.
  /\b(?:beat|beating|break down|breaking down|exploit|exploiting|nullify|neutralis[ez]e|deal with|cope with|get at|stop|stopping) (?:a|an|the|their|them|this|that|it)\b/,
  /\bcounter(?:ing)? (?:a|an|the|their|them|this|that)\b/,
  /\b(?:explain|talk me through|walk me through|thoughts on|what about)\b/,
  /\bget the best out of\b/,
]

/**
 * Asking what is already on the pitch.
 *
 * Checked ahead of `ASKING`, because these are questions the offline half can
 * answer: they are about the board rather than about the game. "How does it
 * look" is the one that forced the split, since the question guard's "how
 * does" cue caught it and sent a `readBoard` off to an assistant that may not
 * be switched on, to answer something `describeBoard` already knows for free.
 */
const SEES_BOARD =
  /\b(?:read the board|what do you see|how does (?:this|it) look|what.?s the shape)\b/

/** What the offline half can honestly say to a question it cannot answer. */
const NEEDS_AI = (formation: string | null) =>
  'Tactics talk goes to the online assistant, which wants an account and your say-so in the panel. ' +
  (formation
    ? `Offline I can set a team up in a ${formation}, move players about and tell you what I see.`
    : 'Offline I can set shapes up, move players about and tell you what I see.')

function detectSide(msg: string, fallback: Side): Side {
  if (/\b(away|opponent|opposition|them|their|other team)\b/.test(msg)) return 'away'
  if (/\b(home|us|our|we|ourselves|my team)\b/.test(msg)) return 'home'
  return fallback
}

/**
 * How high up the pitch the team sits.
 *
 * The three heights are `default`, `mid` and `high`; the toolbar calls them
 * Base, Mid and High, and `BLOCK_LABEL` calls the first one a deep block, which
 * is what it is. A coach names them three ways and this used to know only one of
 * them, the noun phrase: **the bare adjective on the end of a shape was ignored
 * entirely**, so "put them in a 4-3-3 high" set the shape at the base height and
 * said nothing about having dropped the word. The comparative was missing too,
 * and less obviously: `\bdeep\b` does not match "deeper", so "drop them deeper"
 * was not a height at all.
 *
 * Each line is now the bare word plus whatever cannot be reached from it. Every
 * noun phrase already contains its own adjective ("high press" contains "high",
 * "low block" contains "low"), so spelling those out again would be three ways
 * to say the same thing and one place to forget to update.
 *
 * Checked high, mid, then default, and the order carries weight at the bottom:
 * `deep` and `low` are the loosest words here and would otherwise swallow a
 * message that also names one of the other two.
 */
function detectBlock(msg: string): BlockHeight | null {
  if (/\b(?:high(?:er)?|push(?:ed)? up|up the pitch)\b/.test(msg)) return 'high'
  if (/\b(?:mid(?:block)?|medium|halfway)\b/.test(msg)) return 'mid'
  if (/\b(?:low|deep(?:er)?|drop off|sit back|sit deep)\b/.test(msg)) return 'default'
  return null
}

function detectFormation(msg: string, ctx: ParseContext): string | null {
  // Match 3 or 4 single digits, optionally separated by dashes or spaces.
  const m = msg.match(/\b(\d)[-\s]?(\d)[-\s]?(\d)(?:[-\s]?(\d))?\b/)
  if (!m) return null
  const digits = m.slice(1).filter(Boolean).join('')
  const code = formationCode(digits)
  return ctx.formationNames.includes(code) ? code : null
}

export function parseCommand(message: string, ctx: ParseContext): ParseResult {
  const msg = message.toLowerCase().trim()
  if (!msg) return { command: null, reply: CANT_DO }

  const side = detectSide(msg, ctx.defaultSide ?? 'home')
  const sideLabel = side === 'home' ? 'home' : 'away'

  if (SEES_BOARD.test(msg)) return { command: { type: 'readBoard' }, reply: '' }

  // A question goes no further. Every rule below it acts on the board, and a
  // question is the one input where acting is the wrong answer however well the
  // words match. The command stays null, so `runAssistant` hands it to the AI
  // half when that is available and shows this reply when it is not.
  if (ASKING.some((re) => re.test(msg))) {
    return { command: null, reply: NEEDS_AI(detectFormation(msg, ctx)), asking: true }
  }

  // Reset must be checked before "clear", since "clear the board" is a reset.
  if (/\b(reset|clear the board|clear everything|start over|wipe|new board)\b/.test(msg)) {
    return { command: { type: 'resetBoard' }, reply: 'Reset the board to a fresh 4-3-3.' }
  }

  if (/\b(clear|remove|delete|get rid of)\b.*\b(arrow|arrows|drawing|drawings|annotation|annotations|marks?)\b/.test(msg)) {
    return { command: { type: 'clearDrawings' }, reply: 'Cleared the annotations.' }
  }

  // Formation (optionally with a block height).
  const formation = detectFormation(msg, ctx)
  if (formation) {
    const block = detectBlock(msg) ?? 'default'
    return {
      command: { type: 'setFormation', side, name: formation, block },
      reply: `Set the ${sideLabel} team up in a ${formation}${block === 'default' ? '' : ` ${BLOCK_LABEL[block]}`}.`,
    }
  }

  // Player-level instructions sit here on purpose: after the formation check,
  // so "put them in a 4-2-3-1 high line" is still a shape rather than a shirt
  // number 4 being sent up the pitch, and before the block check, so "push 5
  // onto the high line" moves the five rather than the whole team. Every rule
  // below needs a digit, which is what keeps team-wide phrasings out of them.
  const moved = msg.match(/\b(?:move|put|push|drop|shift|send|slide|pull)\b\D*?(\d{1,2})\b/)
  const zone = moved && ZONE_WORDS.find(([re]) => re.test(msg))?.[1]
  if (moved && zone) {
    const number = Number(moved[1])
    return {
      command: { type: 'movePlayer', side, number, zone },
      reply: `Moved ${sideLabel} ${number} to ${ZONE_LABEL[zone]}.`,
    }
  }

  // Bench is checked before return because "sub 7 off" and "sub 7 on" differ by
  // a single word, and only the bench rules name the word that separates them.
  const benched = msg.match(/\bbench\b\D*?(\d{1,2})\b/) ?? msg.match(/\b(\d{1,2})\b\D*?\b(?:off|bench)\b/)
  if (benched) {
    const number = Number(benched[1])
    return {
      command: { type: 'benchPlayer', side, number },
      reply: `Sent ${sideLabel} ${number} to the bench.`,
    }
  }

  const returned = msg.match(/\b(?:bring|return|sub)\b(?:\s+on)?\D*?(\d{1,2})\b/)
  if (returned) {
    const number = Number(returned[1])
    return {
      command: { type: 'returnPlayer', side, number },
      reply: `Brought ${sideLabel} ${number} back on.`,
    }
  }

  // Block height on its own (re-applies that team's shape at a new height).
  //
  // There used to be a second regex here requiring a block-ish word before this
  // rule would fire, guarding against `detectBlock` matching a bare "deep" in a
  // message that was about something else. It never rejected anything: every
  // word `detectBlock` triggers on was already in the guard's own list, so the
  // condition was a restatement of the line above it. Once the heights learned
  // the comparatives it turned from redundant to wrong, because `\bhigh\b` and
  // `\bdeep\b` do not match "higher" and "deeper", so the guard started
  // rejecting the very phrasings that had just been added.
  const block = detectBlock(msg)
  if (block) {
    return {
      command: { type: 'setBlock', side, block },
      reply: `Moved the ${sideLabel} team into a ${BLOCK_LABEL[block]}.`,
    }
  }

  if (/\b(vertical|portrait|rotate|flip)\b/.test(msg) && !/horizontal/.test(msg)) {
    return { command: { type: 'setView', view: 'fullV' }, reply: 'Flipped the pitch to vertical.' }
  }
  if (/\b(horizontal|landscape)\b/.test(msg)) {
    return { command: { type: 'setView', view: 'fullH' }, reply: 'Set the pitch to horizontal.' }
  }
  if (/\battacking half\b/.test(msg)) {
    return { command: { type: 'setView', view: 'attackHalf' }, reply: 'Showing the attacking half.' }
  }
  if (/\bdefending half\b/.test(msg)) {
    return { command: { type: 'setView', view: 'defendHalf' }, reply: 'Showing the defending half.' }
  }

  if (/\b(channels?|half-?spaces?|thirds|grid|zones overlay)\b/.test(msg)) {
    return { command: { type: 'toggleGrid' }, reply: 'Toggled the channels and thirds overlay.' }
  }

  if (/\b(add|capture|take|new)\b.*\b(frame|snapshot|keyframe)\b/.test(msg) || /\bsnapshot\b/.test(msg)) {
    return { command: { type: 'addFrame' }, reply: 'Captured the current positions as a frame.' }
  }

  if (/\b(play|animate|run the animation|run it)\b/.test(msg)) {
    return { command: { type: 'play' }, reply: 'Playing the animation.' }
  }

  if (/\b(fit|reset the view|re-?centre|re-?center|zoom to fit)\b/.test(msg)) {
    return { command: { type: 'fit' }, reply: 'Fit the pitch to the view.' }
  }

  // The looser half of the board-description phrasings. `SEES_BOARD` above runs
  // before the question guard because those wordings can only mean the pitch;
  // these three take an object, and "analyse how we beat a 4-3-3" is a question
  // about the game rather than a request to read out the shapes, so they sit
  // here where the guard has already had its say.
  if (/\b(?:describe|analyse|analyze)\b/.test(msg)) {
    return { command: { type: 'readBoard' }, reply: '' }
  }

  return { command: null, reply: CANT_DO }
}
