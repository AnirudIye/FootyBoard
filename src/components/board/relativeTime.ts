const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const UNITS = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
] as const

/**
 * "3 minutes ago", "in 2 hours", "now": one formatter for the board list and
 * for how long a join code has left, in place of a bespoke one each. Takes a
 * signed offset from now, in milliseconds, and rounds towards now, so "in 1
 * hour" never means "in fifty seconds".
 */
export function relativeTime(ms: number): string {
  for (const [unit, size] of UNITS) {
    if (Math.abs(ms) >= size) return rtf.format(Math.trunc(ms / size), unit)
  }
  return rtf.format(0, 'second')
}
