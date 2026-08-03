import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import ChangePasswordPage from './ChangePasswordPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'

/**
 * Changing a password while signed in, which had no test file at all until the
 * reveal toggle needed one.
 *
 * The three boxes are not three of the same thing, and the distinction is the
 * point of most of what is below: the first is a password being *proved*, the
 * other two are a password being *set*. They carry different `autoComplete`
 * hints for that reason, and a manager that gets them the wrong way round offers
 * the old password as the new one.
 */

vi.mock('../../lib/api', () => ({
  api: {
    securityQuestions: vi
      .fn()
      .mockResolvedValue({ questions: [{ id: 'first-pet', label: 'First pet?' }] }),
    changePassword: vi.fn(),
  },
}))

const mockApi = api as unknown as { changePassword: Mock }

const NEW = 'Prehnite!7712'

const signedIn = {
  id: 'u1',
  email: 'coach@example.com',
  displayName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  isGuest: false,
  twoFactorEnabled: false,
}

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

const at = () =>
  render(
    <MemoryRouter initialEntries={['/password']}>
      <ChangePasswordPage />
      <Where />
    </MemoryRouter>,
  )

const submit = async () => {
  await act(async () => {
    fireEvent.submit(document.querySelector('form')!)
  })
}

const fill = (confirm = NEW) => {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the-old-one' } })
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW } })
  fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: confirm } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.changePassword.mockResolvedValue(undefined)
  useAuthStore.setState({ user: signedIn, ready: true })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ready: false })
})

describe('changing a password', () => {
  it('can show any of the three boxes, one at a time', () => {
    at()
    const toggles = screen.getAllByRole('button', { name: 'Show password' })
    expect(toggles).toHaveLength(3)

    fireEvent.click(toggles[1])
    expect((screen.getByLabelText('New password') as HTMLInputElement).type).toBe('text')
    // The other two are untouched. A page-wide reveal would put the old password
    // and the new one on screen together for anybody standing behind.
    expect((screen.getByLabelText('Current password') as HTMLInputElement).type).toBe('password')
    expect((screen.getByLabelText('Confirm') as HTMLInputElement).type).toBe('password')
  })

  it('keeps the password manager hints, which are not the same on all three', () => {
    at()
    expect(screen.getByLabelText('Current password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    )
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Confirm')).toHaveAttribute('autocomplete', 'new-password')
  })

  it('opens focused on the box that is typed in first', () => {
    at()
    expect(screen.getByLabelText('Current password')).toHaveFocus()
  })

  it('still refuses two new passwords that do not match', async () => {
    at()
    fill('Prehnite!7721')
    await submit()

    expect(screen.getByText('Those two passwords do not match.')).toBeInTheDocument()
    expect(mockApi.changePassword).not.toHaveBeenCalled()
  })

  it('sends the old one, the new one and the question, and not the copy', async () => {
    at()
    await act(async () => {})
    fill()
    fireEvent.change(screen.getByLabelText('Security question'), { target: { value: 'first-pet' } })
    fireEvent.change(screen.getByLabelText(/^Answer/), { target: { value: 'Rufus' } })
    await submit()

    expect(mockApi.changePassword).toHaveBeenCalledWith('the-old-one', NEW, 'first-pet', 'Rufus')
  })

  it('says so and keeps the form when the old password is wrong', async () => {
    mockApi.changePassword.mockRejectedValue(new AppError('That is not your current password.'))
    at()
    fill()
    await submit()

    expect(screen.getByText('That is not your current password.')).toBeInTheDocument()
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe(NEW)
  })
})
