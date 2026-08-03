import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import ClaimPage from './ClaimPage'
import { useAuthStore } from '../../store/authStore'

/**
 * The page where a guest gives their account a password, and why a typo here
 * costs more than the same typo at signup.
 *
 * The account being given credentials **already holds every board this person
 * has made**. That is the whole reason the page exists: without it, guest
 * admission is a mechanism for losing work.
 *
 * And the failure is silent. `POST /api/auth/claim` leaves the session alone, on
 * purpose and correctly — the browser making the request is holding the only way
 * in and there is no older session to revoke — so a mistyped password locks
 * nobody out today. It surfaces the first time they sign in from somewhere else,
 * days later, long past the moment retyping would have fixed it, with no reset
 * email and a security question they set in the same ninety seconds. Everywhere
 * else in this product a wrong password fails in one second and gets retyped.
 * This is the one form where it goes quiet and waits.
 *
 * So both halves are asserted here: the password can be looked at, and it has to
 * be typed twice.
 */

vi.mock('../../lib/api', () => ({
  api: {
    securityQuestions: vi
      .fn()
      .mockResolvedValue({ questions: [{ id: 'first-pet', label: 'First pet?' }] }),
  },
}))

const GUEST = {
  id: 'g1',
  email: null,
  displayName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  isGuest: true,
  twoFactorEnabled: false,
}

const PASSWORD = 'Prehnite!7712'

const real = { claim: useAuthStore.getState().claim }

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname}</span>
}

/**
 * Rendered as a guest whose session has already been checked. Both matter: the
 * page sends a non-guest to `/password` and a stranger to `/signup`, and it
 * waits on `ready` before doing either, because before the session has been
 * checked nobody looks signed in including the people who are.
 */
const at = () =>
  render(
    <MemoryRouter initialEntries={['/claim']}>
      <ClaimPage />
      <Where />
    </MemoryRouter>,
  )

beforeEach(() => {
  useAuthStore.setState({
    user: GUEST,
    ready: true,
    claim: vi.fn().mockResolvedValue(undefined),
  })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ready: false, ...real })
  vi.clearAllMocks()
})

const submit = async () => {
  const form = document.querySelector('form')!
  await act(async () => {
    fireEvent.submit(form)
  })
}

const fill = (password = PASSWORD, confirm = password) => {
  fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
    target: { value: 'coach@example.com' },
  })
  fireEvent.change(screen.getByPlaceholderText('Coach Ade'), { target: { value: 'Ade' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: confirm } })
}

const claim = () => useAuthStore.getState().claim as Mock

describe('ClaimPage and looking at the password being set', () => {
  it('conceals it until it is asked', () => {
    at()
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password')
  })

  it('shows it, and keeps what was typed', () => {
    at()
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0])

    const box = screen.getByLabelText('Password') as HTMLInputElement
    expect(box.type).toBe('text')
    expect(box.value).toBe(PASSWORD)
  })

  it('still tells a password manager this is a new password', () => {
    // Not `current-password`. The account has none, and offering a saved one
    // here would be offering the wrong account's.
    at()
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
  })
})

describe('ClaimPage confirming the password', () => {
  const MESSAGE = 'Those two passwords do not match.'

  it('asks for it twice', () => {
    at()
    expect(screen.getByLabelText('Confirm')).toBeInTheDocument()
  })

  it('refuses two that do not match, in the same words the other forms use', async () => {
    at()
    fill(PASSWORD, 'Prehnite!7721')
    await submit()

    expect(screen.getByText(MESSAGE)).toBeInTheDocument()
    expect(claim()).not.toHaveBeenCalled()
    // And nobody is taken anywhere: the boards this page exists to keep are on
    // the other side of a form that has not been submitted.
    expect(screen.getByTestId('where')).toHaveTextContent('/claim')
  })

  it('sends one password when they match, and not the copy', async () => {
    // `POST /api/auth/claim` takes one password and should keep taking one.
    at()
    fill()
    await submit()

    expect(claim().mock.calls[0]).toEqual(['coach@example.com', PASSWORD, false, '', '', 'Ade'])
  })

  it('goes back to the board once it is through', async () => {
    at()
    fill()
    await submit()
    expect(screen.getByTestId('where')).toHaveTextContent('/board')
  })

  it('lets a corrected mismatch through', async () => {
    at()
    fill(PASSWORD, 'Prehnite!7721')
    await submit()
    expect(screen.getByText(MESSAGE)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: PASSWORD } })
    await submit()

    expect(claim()).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(MESSAGE)).toBeNull()
  })

  it('says what went wrong when the server refuses, without losing either box', async () => {
    // The mismatch guard must not have replaced the error path that was already
    // there: an address already in use is refused by the server, not here.
    claim().mockRejectedValueOnce(new Error('boom'))
    at()
    fill()
    await submit()

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(PASSWORD)
    expect((screen.getByLabelText('Confirm') as HTMLInputElement).value).toBe(PASSWORD)
  })
})
