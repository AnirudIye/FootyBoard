import { useBoardStore } from '../../store/boardStore'
import { useAssistantStore } from '../../store/assistantStore'
import { parseCommand, zonePosition } from '../../lib/parser'
import type { Command } from '../../lib/parser'
import { FORMATION_NAMES, mirror } from '../../lib/formations'
import { describeBoard } from '../../lib/serializer'
import { toUserMessage } from '../../lib/errors'
import { api } from '../../lib/api'
import type { Side, Token } from '../../lib/types'
import { boardHandles } from './boardHandles'

interface Outcome {
  reply: string
  undoable: boolean
}

/** What a tactical question gets when the assistant it needs cannot be reached. */
const UNREACHABLE =
  "I couldn't reach the assistant to answer that. The board still works: try again in a moment."

type Board = ReturnType<typeof useBoardStore.getState>

/**
 * Find a player by side and shirt number.
 *
 * Numbers are per-side, so both halves of the pair are needed to name anyone:
 * there is a 9 on each team. Nothing guarantees uniqueness within a side either
 * (the inspector will happily give two players the same number), so this takes
 * the first, which is the one drawn on top.
 */
const playerOn = (s: Board, side: Side, number: number): Token | undefined =>
  s.tokens.find((t) => t.type === 'player' && t.teamId === side && t.number === number)

const playerBenched = (s: Board, side: Side, number: number): Token | undefined =>
  s.bench.find((t) => t.type === 'player' && t.teamId === side && t.number === number)

/**
 * Where a substitute walks on: the halfway line, in their own half.
 *
 * Not the centre spot, which is where the ball sits, and not their own box,
 * where they would arrive underneath the defence. `mirror` is the same half-turn
 * the formations and the zones take.
 */
const SUB_ON = { x: 44, y: 50 }
// Both branches hand back a fresh object. `mirror` already builds one; the home
// side has to spread, or every caller shares one mutable module constant and a
// single careless `at.x +=` moves every future substitution. `zonePosition` in
// the parser spreads for exactly this reason, and the two sitting one call apart
// disagreeing is what makes the omission easy to miss.
const subOnAt = (side: Side) => (side === 'away' ? mirror([SUB_ON])[0] : { ...SUB_ON })

type Runners = {
  [K in Command['type']]?: (command: Extract<Command, { type: K }>, s: Board) => void
}

/**
 * What each command does to the board. Most are a straight forward to a store
 * action that already knows how to do the work, so they are a table rather than
 * a case each; the ones that answer with something other than the parser's own
 * reply, or that decline, are written out in `execute` above the table.
 */
const RUN: Runners = {
  setFormation: (c, s) => s.applyFormation(c.side, c.name, c.block),
  setBlock: (c, s) => {
    // That side's own shape. This read used to be the board's single
    // `lastFormation`, so pushing the away team up applied whatever formation
    // home had been put in last: the depth changed and so did the shape, which
    // is not what was asked for.
    const shape = s.lastFormation[c.side]
    if (shape) s.applyFormation(c.side, shape, c.block)
  },
  clearDrawings: (_c, s) => s.deleteDrawings(s.drawings.map((d) => d.id)),
  resetBoard: (_c, s) => s.resetBoardAction(),
  setView: (c, s) => s.setView({ view: c.view }),
  toggleGrid: (_c, s) => s.setView({ overlayGrid: !s.view.overlayGrid }),
  addFrame: (_c, s) => s.addFrame(),
  play: (_c, s) => s.setPlayback({ playing: true, position: 0 }),
  fit: () => boardHandles.fitPitch?.(),
  movePlayer: (c, s) => {
    const token = playerOn(s, c.side, c.number)
    if (!token) return
    const p = zonePosition(c.zone, c.side)
    s.moveToken(token.id, p.x, p.y)
    // `moveToken` is the middle of a drag in ordinary use, so it parks a
    // snapshot as pending and leaves the history alone until the pointer comes
    // up. One assistant instruction is a whole gesture, and `commit` is what
    // closes it: without this the move is not undoable, and peers keep whatever
    // throttled position happened to be last rather than where it came to rest.
    s.commit()
  },
  benchPlayer: (c, s) => {
    const token = playerOn(s, c.side, c.number)
    if (token) s.benchToken(token.id)
  },
  returnPlayer: (c, s) => {
    const sub = playerBenched(s, c.side, c.number)
    if (!sub) return
    const at = subOnAt(c.side)
    s.unbenchToken(sub.id, at.x, at.y)
  },
}

/** Which of those change the board, and so leave something to take back. */
const UNDOABLE = new Set<Command['type']>([
  'setFormation',
  'setBlock',
  'clearDrawings',
  'resetBoard',
  'addFrame',
  'movePlayer',
  'benchPlayer',
  'returnPlayer',
])

/** Execute a parsed command against the board, with a human reply. */
function execute(command: Command, fallbackReply: string): Outcome {
  const s = useBoardStore.getState()

  switch (command.type) {
    case 'setBlock':
      // Per side, because the shape it would re-apply is per side. A board where
      // home is in a preset and away is on a saved shape can answer for one and
      // not the other, and saying so is better than moving the wrong team.
      if (!s.lastFormation[command.side]) {
        return {
          reply: `Set the ${command.side} team up in a formation first, then I can change its block height.`,
          undoable: false,
        }
      }
      break

    case 'clearDrawings':
      if (s.drawings.length === 0) {
        return { reply: 'There were no annotations to clear.', undoable: false }
      }
      break

    case 'play':
      if (s.frames.length < 2) {
        return { reply: 'Add at least two frames and I can play the sequence.', undoable: false }
      }
      break

    case 'readBoard':
      return { reply: describeBoard(s.tokens, s.view), undoable: false }

    // A number nobody is wearing is the one thing that goes wrong often here,
    // because the AI is working from a description of shapes rather than a team
    // sheet. Say which number and which side, so the coach can see immediately
    // whether they mistyped or the player is off the pitch.
    case 'movePlayer':
    case 'benchPlayer':
      if (!playerOn(s, command.side, command.number)) {
        return {
          reply: `There is no ${command.number} on the ${command.side} side right now.`,
          undoable: false,
        }
      }
      break

    case 'returnPlayer':
      if (!playerBenched(s, command.side, command.number)) {
        return {
          reply: `There is no ${command.number} on the ${command.side} bench right now.`,
          undoable: false,
        }
      }
      break
  }

  // The table is keyed by the same discriminant the command carries, which the
  // compiler cannot follow across the lookup even though the mapped type above
  // guarantees it.
  const run = RUN[command.type] as ((c: Command, s: Board) => void) | undefined
  run?.(command, s)
  return { reply: fallbackReply, undoable: UNDOABLE.has(command.type) }
}

/** Run a command through the board, reporting whatever comes back. */
function commit(command: Command, reply: string) {
  const assistant = useAssistantStore.getState()
  // A failed command should read as an answer, not vanish or crash the panel.
  try {
    const outcome = execute(command, reply)
    assistant.push('assistant', outcome.reply, outcome.undoable)
  } catch (err) {
    assistant.push('assistant', toUserMessage(err, "That didn't work on the board. Try rephrasing it."))
  }
}

/**
 * Ask the server's AI fallback, and run whatever it comes back with.
 *
 * The model does not act on the board: it picks from a list of functions that
 * mirror `Command`, and the result goes through the same `execute` the parser
 * feeds. Anything it returns that `execute` does not recognise falls through to
 * that switch's default and simply replies.
 */
async function askAI(text: string, offlineReply: string) {
  const assistant = useAssistantStore.getState()
  const board = useBoardStore.getState()

  try {
    // `consent` is not a hint to the server, it is the record the server keeps:
    // a request without it is refused. This path is only reached once the
    // switch in the panel is on, so it is never anything but true here.
    const request = {
      message: text,
      board: describeBoard(board.tokens, board.view),
      formationNames: FORMATION_NAMES[board.view.kind],
      kind: board.view.kind,
      activeTeam: board.activeTeam,
      consent: true,
    }
    const result = await api.askAssistant(request)

    if (result.command) {
      commit(result.command as Command, result.reply ?? 'Done.')
      return
    }
    assistant.push('assistant', result.reply ?? offlineReply)
  } catch (err) {
    // The offline parser already produced a "didn't understand" line. Showing
    // the transport failure instead is more honest than pretending the message
    // was simply unclear.
    assistant.push('assistant', toUserMessage(err, offlineReply))
  }
}

/**
 * Handle a user message end to end: echo it, parse, act, and reply.
 *
 * The rule-based parser runs first and always. It is instant, free, and works
 * with no network — so every phrasing it knows costs nothing and behaves the
 * same as it always has. The AI is reached only for what it does not
 * recognise, and only when the server has a key configured.
 */
export function runAssistant(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const assistant = useAssistantStore.getState()
  assistant.push('user', trimmed)

  const board = useBoardStore.getState()
  const ctx = {
    formationNames: FORMATION_NAMES[board.view.kind],
    kind: board.view.kind,
    defaultSide: board.activeTeam,
  }
  const { command, reply, asking } = parseCommand(trimmed, ctx)

  if (command) {
    commit(command, reply)
    return
  }

  // Both gates: the server has to have a key, and the person has to have said
  // their board may leave the device. Either one missing means the offline
  // answer stands.
  const { aiAvailable, aiConsented } = useAssistantStore.getState()
  if (!aiAvailable || !aiConsented) {
    assistant.push('assistant', reply)
    return
  }

  assistant.setThinking(true)
  // Past this line the AI is on, so the parser's reply has stopped being true
  // for a question: it says to turn on a thing that is already on. What is left
  // to go wrong here is the network, and that is what the fallback should say.
  const fallback = asking ? UNREACHABLE : reply
  void askAI(trimmed, fallback).finally(() => useAssistantStore.getState().setThinking(false))
}
