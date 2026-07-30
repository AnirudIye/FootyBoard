import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import SignOutEverywherePage from './SignOutEverywherePage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'

/**
 * Ending every session without changing the password.
 *
 * A page rather than a control that acts where it is clicked, and the reason is
 * the same one that made `/password` a page. This deliberately destroys the
 * caller's own session and mints a replacement, so the board's live room is
 * closed by the eviction it asked for. Done from the board, the room reports
 * "your session has ended, sign in again" and the save indicator drops to "not
 * saving", both of which are untrue of a browser holding a session the server
 * minted a moment ago. Off the board there is no room to close, and coming back
 * mounts a fresh one on the new cookie.
 *
 * It also wants a real password field. A native prompt would be smaller and
 * would put a credential on screen in plain text, where no password manager can
 * fill it.
 */

vi.mock('../../lib/api', () => ({
  api: { signOutEverywhere: vi.fn() },
}))

const mockApi = api as unknown as { signOutEverywhere: Mock }

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

const at = (path = '/sessions') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SignOutEverywherePage />
      <Where />
    </MemoryRouter>,
  )

const where = () => screen.getByTestId('where').textContent

const submit = async (password: string) => {
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: password } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
  })
}

const signedIn = { id: 'u1', email: 'coach@example.com', displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: false, twoFactorEnabled: false }
const guest = { id: 'g1', email: null, displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: true, twoFactorEnabled: false }

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.signOutEverywhere.mockResolvedValue({ ok: true })
  useAuthStore.setState({ user: signedIn, ready: true })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ready: false })
})

describe('ending every session', () => {
  it('sends the password that was typed, and nothing else', async () => {
    at()
    await submit('the-only-password')

    expect(mockApi.signOutEverywhere).toHaveBeenCalledWith('the-only-password')
  })

  it('says the password is unchanged, which is the whole difference from /password', async () => {
    // Somebody arrives here because they suspect a session has been taken, not
    // because they want new credentials. If the confirmation does not say that
    // the password stands, the safe assumption is that it changed and every other
    // device now needs one nobody chose.
    at()
    await submit('the-only-password')

    const said = document.body.textContent ?? ''
    expect(said).toMatch(/password has not changed/i)
    expect(said).toMatch(/still signed in/i)
  })

  it('carries no em dash in anything it says', async () => {
    at()
    await submit('the-only-password')
    expect(document.body.textContent ?? '').not.toMatch(/—/)
  })

  it('shows a refusal rather than claiming it worked', async () => {
    // The server's message is already safe to show, and it is the useful one: a
    // wrong password is the failure this endpoint is meant to have.
    mockApi.signOutEverywhere.mockRejectedValue(new AppError('That is not your current password.'))
    at()
    await submit('a-guess')

    expect(screen.getByText('That is not your current password.')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toMatch(/has not changed/i)
  })
})

describe('who may reach it', () => {
  it('sends a guest to claiming their account instead', async () => {
    // A guest has no password to confirm and exactly one session, which is the
    // browser asking. What they actually need is credentials on that account.
    useAuthStore.setState({ user: guest, ready: true })
    at()

    // The redirect is the whole assertion. This mounts the page directly rather
    // than through the route table, so it stays on screen after navigating; in
    // the app `/claim` renders another page over it.
    expect(where()).toBe('/claim')
  })

  it('sends a visitor to sign in, and back here afterwards', async () => {
    useAuthStore.setState({ user: null, ready: true })
    at()

    expect(where()).toBe('/login?next=/sessions')
  })

  it('waits until the session has been checked before deciding either', async () => {
    // Before `restore()` answers, nobody looks signed in, including the people
    // who are. Redirecting on that would bounce every arrival to the login page.
    useAuthStore.setState({ user: null, ready: false })
    at()

    expect(where()).toBe('/sessions')
  })
})
