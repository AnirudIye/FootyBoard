import { create } from 'zustand'
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '../theme/theme'

interface ThemeState {
  /** What was chosen, `system` included. */
  preference: ThemePreference
  /** What is painted right now, which is what components should read. */
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

/**
 * The chosen palette, as the interface reads it.
 *
 * The attribute on `:root` is the source of truth for *styling* and is written
 * by `applyTheme` before React exists. This store exists so a control can show
 * which of the three is chosen and so anything that has to branch in JavaScript
 * (rather than in CSS) has one place to ask. The two are kept in step by this
 * being the only writer.
 */
export const useThemeStore = create<ThemeState>((set) => ({
  preference: readThemePreference(),
  resolved: resolveTheme(readThemePreference()),

  setPreference: (preference) => {
    storeThemePreference(preference)
    set({ preference, resolved: applyTheme(preference) })
  },
}))

/**
 * Keep `system` honest for the life of the page.
 *
 * Started once, at module scope, rather than from an effect in a component:
 * there is one document and one `:root`, so a per-component subscription would
 * be several listeners writing the same attribute. Reads the preference at fire
 * time so it costs nothing while somebody has chosen explicitly.
 */
watchSystemTheme(() => {
  const { preference } = useThemeStore.getState()
  if (preference !== 'system') return
  useThemeStore.setState({ resolved: applyTheme('system') })
})
