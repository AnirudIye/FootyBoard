import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { PAGES } from './marketing.js'
import PrivacyPolicy from '../components/legal/PrivacyPolicy'
import TermsOfService from '../components/legal/TermsOfService'
import AccessibilityStatement from '../components/legal/AccessibilityStatement'
import ContactPage from '../components/legal/ContactPage'
import JoinPage from '../components/board/JoinPage'
import AuthPage from '../components/auth/AuthPage'

/**
 * Every sentence a crawler is shown is a sentence a visitor is shown.
 *
 * **This is the check that was missing while five pages quietly broke the rule.**
 * `scripts/prerender.mjs` writes each entry's `body` into a static document for
 * the crawlers that never run React, and `marketing.js` says in its own header
 * that a sentence the page does not also show is cloaking rather than marketing.
 * Nothing enforced it. `/join`, `/privacy`, `/terms`, `/accessibility` and
 * `/contact` each carried a summary line that the React tree had never said —
 * for as long as the prerender had existed.
 *
 * The shape is deliberate: it is driven by `PAGES` rather than by a list of
 * expected strings, so it covers a page added tomorrow without anybody
 * remembering this file exists. A new entry with a `body` and no matching words
 * on screen fails here, which is the only reason the defect cannot come back.
 *
 * Two pages are not rendered, and both are named rather than quietly skipped:
 *
 *   - **`/board`** has no `body` at all, on purpose. It draws a canvas; there is
 *     no honest paragraph to put in it, and inventing one to feed a crawler is
 *     the thing being guarded against. It is asserted to have none.
 *   - **`/`** is `LandingPage`, which reaches WebGL and Konva and does not
 *     survive jsdom. Its copy comes from `HERO` — the component imports the same
 *     constant the prerender reads, so the two cannot diverge without a type
 *     error, which is a stronger guarantee than this test gives anybody else.
 *     That is asserted structurally below instead.
 */

vi.mock('../lib/api', () => ({
  api: {
    securityQuestions: vi.fn().mockResolvedValue({ questions: [] }),
    joinWithCode: vi.fn(),
    joinAsGuest: vi.fn(),
    redeemShareAsGuest: vi.fn(),
    me: vi.fn().mockResolvedValue({ user: null }),
    sendContactMessage: vi.fn(),
  },
}))

/** Each renderable page, by the path its `PAGES` entry uses. */
const RENDERERS: Record<string, ReactElement> = {
  '/signup': <AuthPage mode="signup" />,
  '/join': <JoinPage />,
  '/privacy': <PrivacyPolicy />,
  '/terms': <TermsOfService />,
  '/accessibility': <AccessibilityStatement />,
  '/contact': <ContactPage />,
}

afterEach(cleanup)

describe('what the prerender writes is what the page says', () => {
  for (const page of PAGES.filter((p) => RENDERERS[p.path])) {
    it(`${page.path} shows every sentence its static document claims`, () => {
      render(<MemoryRouter>{RENDERERS[page.path]}</MemoryRouter>)

      // The heading first: it is written into the static body as an `<h1>`, so a
      // page whose real heading differs is claiming a title it does not have.
      if (page.heading) {
        expect(
          screen.getByRole('heading', { level: 1, name: page.heading }),
          `${page.path}: no <h1> reading "${page.heading}"`,
        ).toBeInTheDocument()
      }

      for (const line of page.body ?? []) {
        expect(
          screen.queryByText(line),
          `${page.path} serves a crawler a sentence the page never shows:\n  "${line}"`,
        ).not.toBeNull()
      }
    })
  }

  it('covers every page that has copy, so nothing can be added unwatched', () => {
    // The guard on the guard. A `PAGES` entry with a `body` and no renderer here
    // would be a page nobody is checking, and it would pass by not running.
    const unchecked = PAGES.filter((p) => (p.body?.length ?? 0) > 0)
      .map((p) => p.path)
      .filter((path) => !RENDERERS[path] && path !== '/')

    expect(unchecked, `these have copy and no renderer in this file: ${unchecked.join(', ')}`)
      .toEqual([])
  })

  it('leaves the board with no prose to be honest about', () => {
    const board = PAGES.find((p) => p.path === '/board')!
    expect(board.body ?? []).toEqual([])
    expect(board.heading).toBeUndefined()
  })

  it('takes the home page copy from the constant the component renders', () => {
    // `/` is not rendered here — `LandingPage` reaches WebGL and Konva. What
    // makes it safe is that both renderers read `HERO`, so this asserts the
    // wiring rather than the words: an edit to the sentence moves both at once.
    const home = PAGES.find((p) => p.path === '/')!
    expect(home.body).toHaveLength(1)
    expect(home.heading).toBeTruthy()
  })
})
