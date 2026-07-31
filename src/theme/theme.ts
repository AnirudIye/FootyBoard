/**
 * Which of the two palettes the chrome is wearing.
 *
 * The values live in `tokens.css`: `:root` is floodlit and
 * `:root[data-theme='light']` is daylight. This module owns the one attribute
 * that chooses between them, the preference behind it, and nothing else. It is
 * deliberately not a store: the value has to be on `:root` before React renders
 * anything, or the first paint is the wrong palette and the page flashes.
 *
 * **`system` is a third preference rather than a resolved value**, and keeping
 * it distinct is what lets somebody who has not chosen follow their OS when it
 * changes at dusk. Collapsing it to whatever the OS said at load would freeze
 * them on that answer until they reloaded.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

/** What is actually painted, once `system` has been asked. */
export type ResolvedTheme = 'light' | 'dark'

/**
 * The `soccerboard.` prefix, like every other preference this app keeps in the
 * browser. See the note in handoff.md about why these keys were not renamed
 * when the product was: they are preferences rather than work.
 */
const THEME_KEY = 'soccerboard.theme'

const PREFERENCES: ThemePreference[] = ['system', 'light', 'dark']

const query = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null

/** What the OS is asking for, and dark when it has no opinion or cannot be asked. */
export const systemTheme = (): ResolvedTheme => (query()?.matches ? 'light' : 'dark')

export const resolveTheme = (preference: ThemePreference): ResolvedTheme =>
  preference === 'system' ? systemTheme() : preference

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return PREFERENCES.includes(stored as ThemePreference) ? (stored as ThemePreference) : 'system'
  } catch {
    // Storage can be unavailable or full. Following the OS is the right thing
    // to do when nothing is known, which is exactly what the default already is.
    return 'system'
  }
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, preference)
  } catch {
    // ignore storage failures; the choice simply does not survive the session
  }
}

/**
 * Put the resolved palette on `:root`.
 *
 * Both values are written rather than only `light`, although the stylesheet's
 * dark rules hang off bare `:root` and would apply with the attribute absent.
 * An attribute that is present either way is one anything else can read and
 * one a `[data-theme='dark']` block could later hang off, where an absent
 * attribute means "dark, or nothing has run yet" and those are different.
 */
export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const resolved = resolveTheme(preference)
  root.dataset.theme = resolved
  return resolved
}

/**
 * Follow the OS while the preference is `system`, and stop when it is not.
 *
 * Returns its own teardown. The listener is attached whatever the preference
 * is, and checks at fire time rather than being torn down and rebuilt on every
 * change, because the question "am I following the system right now" is one
 * answer and belongs in one place.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = query()
  if (!mq) return () => {}
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
