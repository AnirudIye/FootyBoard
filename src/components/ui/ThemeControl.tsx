import { useThemeStore } from '../../store/themeStore'
import { Segmented } from './Segmented'
import type { Option } from './Segmented'
import type { ThemePreference } from '../../theme/theme'

/**
 * System first, because it is the default and because it is the answer most
 * people want: follow the machine, and it changes at dusk with everything else.
 * The two explicit choices sit after it in the order the product itself goes,
 * light then dark.
 */
const THEMES: Option<ThemePreference>[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

/**
 * Which palette the interface wears, as a control.
 *
 * In the account popover for all three of its states rather than only the
 * signed-in one, because this is a preference of the browser rather than of the
 * account: a visitor who has not signed in has as much reason to want daylight
 * as anybody, and the setting is remembered for them the same way.
 *
 * **It does not touch the pitch, and that is a decision rather than an
 * omission.** The board carries its own `pitchTheme`, which is part of the board:
 * it is shared with everyone in the room, it is saved, and it is what an
 * exported PNG looks like. A viewer preference that reached into it would mean
 * two people in one room seeing different boards, and one person's choice of
 * theme silently editing somebody else's export. So this changes the chrome
 * around the board, and the pitch stays where the coach put it.
 */
export function ThemeControl() {
  const preference = useThemeStore((s) => s.preference)
  const setPreference = useThemeStore((s) => s.setPreference)

  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
        Appearance
      </p>
      <Segmented options={THEMES} value={preference} onChange={setPreference} />
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
        Changes this browser only. The pitch keeps its own look, which is saved
        with the board.
      </p>
    </div>
  )
}
