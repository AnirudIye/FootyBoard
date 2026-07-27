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

/** Execute a parsed command against the board. Each returns a human reply. */
function execute(command: Command, fallbackReply: string): Outcome {
  const s = useBoardStore.getState()

  switch (command.type) {
    case 'setFormation':
      s.applyFormation(command.side, command.name, command.block)
      return { reply: fallbackReply, undoable: true }

    case 'setBlock': {
      if (!s.lastFormation) {
        return { reply: 'Apply a formation first, then I can change its block height.', undoable: false }
      }
      s.applyFormation(command.side, s.lastFormation, command.block)
      return { reply: fallbackReply, undoable: true }
    }

    case 'clearDrawings': {
      const ids = s.drawings.map((d) => d.id)
      if (ids.length === 0) return { reply: 'There were no annotations to clear.', undoable: false }
      s.deleteDrawings(ids)
      return { reply: fallbackReply, undoable: true }
    }

    case 'resetBoard':
      s.resetBoardAction()
      return { reply: fallbackReply, undoable: true }

    case 'setView':
      s.setView({ view: command.view })
      return { reply: fallbackReply, undoable: false }

    case 'toggleGrid':
      s.setView({ overlayGrid: !s.view.overlayGrid })
      return { reply: fallbackReply, undoable: false }

    case 'addFrame':
      s.addFrame()
      return { reply: fallbackReply, undoable: true }

    case 'play':
      if (s.frames.length < 2) {
        return { reply: 'Add at least two frames and I can play the sequence.', undoable: false }
      }
      s.setPlayback({ playing: true, position: 0 })
      return { reply: fallbackReply, undoable: false }

    case 'fit':
      boardHandles.fitPitch?.()
      return { reply: fallbackReply, undoable: false }

    case 'readBoard':
      return { reply: describeBoard(s.tokens, s.view), undoable: false }

    default:
      return { reply: fallbackReply, undoable: false }
  }
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
    const result = await api.askAssistant({
      message: text,
      board: describeBoard(board.tokens, board.view),
      formationNames: FORMATION_NAMES[board.view.kind],
      kind: board.view.kind,
      activeTeam: board.activeTeam,
    })

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
