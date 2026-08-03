import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import DeleteAccountPage from './DeleteAccountPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'

/**
 * Deleting the account, which is the one action nothing undoes.
 *
 * This was a `window.confirm` and a `DELETE` carrying no body at all, while the
 * two controls beside it in the same popover both required the current password.
 * The server asks for it now, and for a code as well when two-step sign-in is
 * on, so the page has to collect both and a native prompt cannot: it holds one
 * line, shows a credential in clear text, and no password manager can fill it.
 *
 * A guest is the one account that sends neither, because that row has no
 * password to confirm and the privacy policy promises deletion to everybody.
 */

vi.mock('../../lib/api', () => ({
  api: { deleteAccount: vi.fn() },
}))

const mockApi = api as unknown as { deleteAccount: Mock }

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

const at = () =>
  render(
    <MemoryRouter initialEntries={['/delete-account']}>
      <DeleteAccountPage />
      <Where />
    </MemoryRouter>,
  )

const where = () => screen.getByTestId('where').textContent
const said = () => document.body.textContent ?? ''

const click = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }))
  })
}

const base = {
  id: 'u1',
  email: 'coach@example.com',
  displayName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  isGuest: false,
  twoFactorEnabled: false,
}
const withFactor = { ...base, twoFactorEnabled: true }
const guest = { ...base, id: 'g1', email: null, isGuest: true }

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.deleteAccount.mockResolvedValue(undefined)
  useAuthStore.setState({ user: base, ready: true })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ready: false })
})

describe('deleting an account', () => {
  it('lets the password be looked at, and still opens focused on it', () => {
    // `autoFocus` is the detail most likely to be dropped in the conversion,
    // because it is a bare attribute on the input and the component now stands
    // between the page and that input.
    at()
    const box = () => screen.getByLabelText(/current password/i) as HTMLInputElement
    expect(box()).toHaveFocus()

    fireEvent.change(box(), { target: { value: 'the-real-one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))

    expect(box().type).toBe('text')
    expect(box().value).toBe('the-real-one')
  })

  it('sends the password that was typed, and no code when there is no factor', async () => {
    at()
    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: 'the-real-one' },
    })
    await click()

    expect(mockApi.deleteAccount).toHaveBeenCalledWith('the-real-one', undefined)
  })

  it('asks for a code as well when the factor is on, and sends both', async () => {
    useAuthStore.setState({ user: withFactor, ready: true })
    at()

    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: 'the-real-one' },
    })
    fireEvent.change(screen.getByLabelText(/^code/i), { target: { value: '123456' } })
    await click()

    expect(mockApi.deleteAccount).toHaveBeenCalledWith('the-real-one', '123456')
  })

  /**
   * The whole reason the factor is required here rather than only at the sign-in
   * form. If the password alone reached this endpoint, somebody holding a stolen
   * session and the password would destroy the account without ever meeting the
   * second factor.
   */
  it('does not offer a code field to an account with no factor', () => {
    at()
    expect(screen.queryByLabelText(/^code/i)).toBeNull()
  })

  it('asks a guest for nothing, because that account has nothing to confirm', async () => {
    useAuthStore.setState({ user: guest, ready: true })
    at()

    expect(screen.queryByLabelText(/current password/i)).toBeNull()
    await click()

    expect(mockApi.deleteAccount).toHaveBeenCalledWith(undefined, undefined)
  })

  /**
   * A refused deletion has changed nothing on the server, so the page must not
   * behave as though it worked. It stays put and repeats what the server said,
   * because "that is not your current password" is the useful sentence here.
   */
  it('stays on the page and says why when the server refuses', async () => {
    mockApi.deleteAccount.mockRejectedValue(new AppError('That is not your current password.'))
    at()
    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: 'wrong' },
    })
    await click()

    expect(where()).toBe('/delete-account')
    expect(said()).toMatch(/not your current password/i)
    expect(useAuthStore.getState().user).not.toBeNull()
  })

  /**
   * The redirect this page owes a *visitor* must not fire at the one moment
   * being signed out is the correct outcome.
   *
   * A successful deletion clears `user`, so without a guard the effect sees
   * nobody signed in and sends the person to `/login?next=/delete-account`: a
   * sign-in form, for an account that no longer exists, as the last thing they
   * are shown. It said exactly that before the guard existed.
   */
  it('confirms rather than bouncing to a sign-in form for the account it just deleted', async () => {
    at()
    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: 'the-real-one' },
    })
    await click()

    expect(where()).toBe('/delete-account')
    expect(said()).toMatch(/your account has been deleted/i)
    // Not a text match on "sign in": the confirmation itself says there is
    // nothing left to sign in to. What must not have happened is the route
    // change and the form coming back.
    expect(where()).not.toMatch(/login/)
    expect(screen.queryByLabelText(/current password/i)).toBeNull()
  })

  it('sends a visitor to sign in, carrying where they were going', () => {
    useAuthStore.setState({ user: null, ready: true })
    at()
    expect(where()).toBe('/login?next=/delete-account')
  })

  /** The product rule, asserted rather than remembered. */
  it('puts no em dash in front of anybody', () => {
    at()
    expect(said()).not.toMatch(/—/)
  })
})
