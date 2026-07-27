import { useBoardStore } from '../../store/boardStore'
import { useAssistantStore } from '../../store/assistantStore'
import { parseCommand } from '../../lib/parser'
import type { Command } from '../../lib/parser'
import { FORMATION_NAMES } from '../../lib/formations'
import { describeBoard } from '../../lib/serializer'
import { toUserMessage } from '../../lib/errors'
import { api } from '../../lib/api'
import { boardHandles } from './boardHandles'

interface Outcome {
  reply: string
  undoable: boolean
}

type Board = ReturnType<typeof useBoardStore.getState>

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
    if (s.lastFormation) s.applyFormation(c.side, s.lastFormation, c.block)
  },
  clearDrawings: (_c, s) => s.deleteDrawings(s.drawings.map((d) => d.id)),
  resetBoard: (_c, s) => s.resetBoardAction(),
  setView: (c, s) => s.setView({ view: c.view }),
  toggleGrid: (_c, s) => s.setView({ overlayGrid: !s.view.overlayGrid }),
  addFrame: (_c, s) => s.addFrame(),
  play: (_c, s) => s.setPlayback({ playing: true, position: 0 }),
  fit: () => boardHandles.fitPitch?.(),
}

/** Which of those change the board, and so leave something to take back. */
const UNDOABLE = new Set<Command['type']>([
  'setFormation',
  'setBlock',
  'clearDrawings',
  'resetBoard',
  'addFrame',
])

/** Execute a parsed command against the board, with a human reply. */
function execute(command: Command, fallbackReply: string): Outcome {
  const s = useBoardStore.getState()

  switch (command.type) {
    case 'setBlock':
      if (!s.lastFormation) {
        return { reply: 'Apply a formation first, then I can change its block height.', undoable: false }
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
  const { command, reply } = parseCommand(trimmed, ctx)

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
  void askAI(trimmed, reply).finally(() => useAssistantStore.getState().setThinking(false))
}
