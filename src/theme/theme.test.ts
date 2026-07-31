import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  systemTheme,
} from './theme'

/**
 * Which palette gets painted, and the one question underneath it: what happens
 * to somebody who has never touched the setting.
 *
 * The values themselves live in `tokens.css` and are not testable here; what is
 * testable is the choosing, and the choosing is where a theme feature usually
 * goes wrong. Two failures in particular: following the OS by resolving it once
 * at load, so the page never changes at dusk; and treating a missing preference
 * as "dark" rather than as "ask", so somebody on a light machine gets the dark
 * theme forever and no control ever tells them why.
 */

/** Stand in for the OS preference. `matches` is `(prefers-color-scheme: light)`. */
const systemSays = (light: boolean) =>
  vi.stubGlobal('matchMedia', () => ({
    matches: light,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the theme preference', () => {
  it('asks the system when nothing has been chosen', () => {
    expect(readThemePreference()).toBe('system')
  })

  it('reads back what was chosen', () => {
    storeThemePreference('light')
    expect(readThemePreference()).toBe('light')
  })

  /**
   * A value that is not one of the three is a key somebody else wrote, or one
   * this app wrote in an older shape. Falling back to `system` is the same
   * answer as never having chosen, which is the right one: it is the only
   * option that cannot be wrong for the person reading.
   */
  it('ignores a stored value it does not recognise', () => {
    localStorage.setItem('soccerboard.theme', 'sepia')
    expect(readThemePreference()).toBe('system')
  })

  it('survives storage being unavailable', () => {
    const boom = () => {
      throw new Error('denied')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)

    expect(readThemePreference()).toBe('system')
    expect(() => storeThemePreference('dark')).not.toThrow()

    vi.restoreAllMocks()
  })
})

describe('resolving it', () => {
  it('follows the system when that is the preference', () => {
    systemSays(true)
    expect(systemTheme()).toBe('light')
    expect(resolveTheme('system')).toBe('light')

    systemSays(false)
    expect(resolveTheme('system')).toBe('dark')
  })

  it('overrides the system when a choice has been made', () => {
    systemSays(true)
    expect(resolveTheme('dark')).toBe('dark')

    systemSays(false)
    expect(resolveTheme('light')).toBe('light')
  })

  /**
   * A browser that cannot be asked is not a browser that wants light. Dark is
   * the product's own palette, so it is the right answer when there is no
   * answer, and jsdom without a `matchMedia` stub is exactly that case.
   */
  it('falls back to the product’s own palette when there is nothing to ask', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(systemTheme()).toBe('dark')
  })
})

describe('applying it', () => {
  it('writes the resolved palette onto the element, both ways', () => {
    systemSays(false)
    const root = document.createElement('html')

    expect(applyTheme('light', root)).toBe('light')
    expect(root.dataset.theme).toBe('light')

    // Written rather than removed. Absent would mean "dark, or nothing has run
    // yet", and those are not the same state.
    expect(applyTheme('dark', root)).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })

  it('resolves the system preference rather than writing it through', () => {
    systemSays(true)
    const root = document.createElement('html')

    expect(applyTheme('system', root)).toBe('light')
    expect(root.dataset.theme).toBe('light')
  })
})
