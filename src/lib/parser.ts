import type { Side, PitchView, PitchKind } from './types'
import type { BlockHeight } from './formations'
import { formationCode } from './formations'

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

export interface ParseContext {
  formationNames: string[]
  kind: PitchKind
  /** Team to act on when the message names none. Defaults to home. */
  defaultSide?: Side
}

export interface ParseResult {
  command: Command | null
  reply: string
}

const BLOCK_LABEL: Record<BlockHeight, string> = {
  default: 'deep block',
  mid: 'mid block',
  high: 'high line',
}

const CANT_DO =
  "That one's beyond me. Things I can do: set a formation (\"put the away team in a 4-2-3-1 mid block\"), " +
  'push a team higher or drop them deeper, clear the arrows, reset the board, flip the pitch, ' +
  'turn the channels on, take a frame, play the sequence, fit the view, or tell you what I see.'

function detectSide(msg: string, fallback: Side): Side {
  if (/\b(away|opponent|opposition|them|their|other team)\b/.test(msg)) return 'away'
  if (/\b(home|us|our|we|ourselves|my team)\b/.test(msg)) return 'home'
  return fallback
}

function detectBlock(msg: string): BlockHeight | null {
  if (/\b(high line|high block|press high|push up|high press)\b/.test(msg)) return 'high'
  if (/\b(mid[-\s]?block|medium block|halfway)\b/.test(msg)) return 'mid'
  if (/\b(deep|low block|drop off|sit back|deep block)\b/.test(msg)) return 'default'
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

  // Block height on its own (re-applies the current shape at a new height).
  const block = detectBlock(msg)
  if (block && /\b(block|line|press|push|drop|sit|deep|high|mid|halfway)\b/.test(msg)) {
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

  if (/\b(read the board|describe|analyse|analyze|what do you see|how does (this|it) look|what.?s the shape)\b/.test(msg)) {
    return { command: { type: 'readBoard' }, reply: '' }
  }

  return { command: null, reply: CANT_DO }
}
