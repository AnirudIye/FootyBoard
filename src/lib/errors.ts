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
  if (err !== undefined && err !== null) console.error('Soccerboard:', err)
  return fallback
}
