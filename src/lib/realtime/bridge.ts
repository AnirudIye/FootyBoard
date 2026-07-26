import type { Op } from './protocol'

/**
 * The seam between the board and the room.
 *
 * The board store must not import a socket. It is the thing being edited, and
 * it works perfectly well with nobody else connected — making it depend on a
 * transport would invert that. So it calls `emit`, and the realtime hook
 * registers where those ops actually go. With nothing registered, `emit` does
 * nothing, which is exactly what a solo board should do.
 *
 * The `applyingRemote` flag guards the one bug this design could otherwise
 * have: applying a peer's op runs the same store code a local edit runs, so
 * without a guard it would emit that op straight back and the two clients would
 * volley it forever.
 */

type Sink = (op: Op, throttleKey?: string) => void
type FinalSink = (op: Op, throttleKey: string) => void

let sink: Sink | null = null
let finalSink: FinalSink | null = null
let replacedSink: (() => void) | null = null
let applying = false

export function registerSinks(sinks: {
  send: Sink
  sendFinal: FinalSink
  sendReplaced: () => void
}): void {
  sink = sinks.send
  finalSink = sinks.sendFinal
  replacedSink = sinks.sendReplaced
}

export function clearSinks(): void {
  sink = null
  finalSink = null
  replacedSink = null
}

/** True while a peer's op is being applied, so nothing echoes it back. */
export const isApplyingRemote = (): boolean => applying

export function emit(op: Op, throttleKey?: string): void {
  if (applying) return
  sink?.(op, throttleKey)
}

/** The exact resting value at the end of a gesture, past the throttle. */
export function emitFinal(op: Op, throttleKey: string): void {
  if (applying) return
  finalSink?.(op, throttleKey)
}

/**
 * "Everything changed — read it from the server."
 *
 * Undo, redo, reset and changing the pitch format all rewrite the whole board
 * at once, and a full board is far past what a single message may carry. Rather
 * than inventing a chunking scheme for four rare actions, the originator saves
 * and peers re-read. It costs a round trip on an action nobody performs at
 * sixty hertz.
 */
export function emitReplaced(): void {
  if (applying) return
  replacedSink?.()
}

/**
 * Run a mutation as a remote one: no history, no echo.
 *
 * Synchronous on purpose. The flag is module-level, so anything awaited inside
 * would leave it set across unrelated work and silently swallow the user's own
 * edits.
 */
export function runAsRemote<T>(fn: () => T): T {
  applying = true
  try {
    return fn()
  } finally {
    applying = false
  }
}
