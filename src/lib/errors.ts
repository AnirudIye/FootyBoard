/**
 * One place that decides what a failure says on screen.
 *
 * Anything the app throws on purpose is an AppError, whose message is already
 * a sentence a coach can act on. Everything else — a browser refusal, a bug —
 * is mapped onto the same plain language here, so raw text like
 * "QuotaExceededError" or "undefined is not an object" never reaches a toast.
 */

/** A failure with a message that is safe, and useful, to show the user. */
export class AppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * The server refused a write because the board moved on without us.
 *
 * A subclass rather than a status field on `AppError`, so the one place that
 * cares can ask `instanceof` and everywhere else goes on treating it as an
 * ordinary explained failure — `toUserMessage` is untouched, because this is
 * still an AppError and its message is still a sentence.
 *
 * `generation` is where the board actually is. Nothing acts on the number today,
 * since the answer to a refusal is to re-read rather than to retry on it, and
 * that is deliberate: a client that used this to rebase would be doing exactly
 * what the refusal exists to stop. It is carried because a refusal that will not
 * say what it refused against is unreadable in a log.
 */
export class ConflictError extends AppError {
  readonly generation: number

  constructor(message: string, generation: number) {
    super(message)
    this.name = 'ConflictError'
    this.generation = generation
  }
}

// Browser-thrown failures we can explain, keyed by DOMException name.
const BROWSER_CAUSES: Record<string, string> = {
  QuotaExceededError:
    "Your browser is out of storage, so the board didn't save. Clear some space for this site and try again.",
  SecurityError: 'The browser blocked us from reading the board image. Reload the page, then export again.',
  NotSupportedError: "Your browser can't do this one. Chrome or Edge will.",
}

/**
 * Turn anything thrown into a sentence worth showing. Unrecognised failures
 * keep their detail in the console for debugging and show `fallback` instead,
 * because their raw text is written for developers, not coaches.
 */
export function toUserMessage(
  err: unknown,
  fallback = 'That went wrong somewhere. Give it another go.',
): string {
  if (err instanceof AppError) return err.message

  const name = err instanceof Error ? err.name : ''
  if (name && BROWSER_CAUSES[name]) return BROWSER_CAUSES[name]

  // Not a failure we have wording for: keep the technical detail off screen.
  if (err !== undefined && err !== null) console.error('FootyBoard:', err)
  return fallback
}
