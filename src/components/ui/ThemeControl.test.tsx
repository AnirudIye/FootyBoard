import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ThemeControl } from './ThemeControl'
import { useThemeStore } from '../../store/themeStore'
import { applyTheme } from '../../theme/theme'

/**
 * The control, driven the way somebody drives it.
 *
 * `theme.test.ts` covers the choosing; this covers the wiring between the
 * control, the attribute the stylesheet hangs off, and the key the choice is
 * remembered in. Those are three files, and this repo's recurring failure is
 * work that is correct in each file and unconnected across them.
 */

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false, // the OS is asking for dark
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  useThemeStore.setState({ preference: 'system', resolved: 'dark' })
  applyTheme('system')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

const pick = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }))
const painted = () => document.documentElement.dataset.theme

describe('the appearance control', () => {
  it('offers the three preferences and marks the one in force', () => {
    render(<ThemeControl />)

    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Dark' })).toBeTruthy()
  })

  it('repaints the page when a palette is chosen', () => {
    render(<ThemeControl />)
    expect(painted()).toBe('dark')

    pick('Light')

    expect(painted()).toBe('light')
    expect(useThemeStore.getState().resolved).toBe('light')
  })

  it('remembers the choice for the next visit', () => {
    render(<ThemeControl />)

    pick('Light')

    expect(localStorage.getItem('soccerboard.theme')).toBe('light')
  })

  /**
   * The one that would be easy to get wrong: going back to `system` has to
   * re-ask the OS rather than keep whatever was last painted. Here the OS wants
   * dark, so choosing light and then System must land back on dark.
   */
  it('hands the decision back to the system', () => {
    render(<ThemeControl />)
    pick('Light')
    expect(painted()).toBe('light')

    pick('System')

    expect(painted()).toBe('dark')
    expect(useThemeStore.getState().preference).toBe('system')
    expect(localStorage.getItem('soccerboard.theme')).toBe('system')
  })

  /** It says what it does and does not touch, because the pitch is not this. */
  it('says the pitch is not what it changes', () => {
    render(<ThemeControl />)
    expect(screen.getByText(/pitch keeps its own look/i)).toBeTruthy()
  })
})
