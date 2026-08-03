import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ResetPasswordPage from './ResetPasswordPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'

/**
 * The last step of a recovery, which had no test file until the reveal toggle
 * needed one.
 *
 * The token arrives in **history state** rather than in the URL, put there by
 * `ForgotPasswordPage` once the security question was answered. That is what the
 * entry below is exercising: rendered without it, there is nothing to finish and
 * the page has to say so rather than showing a form that cannot work.
 */

vi.mock('../../lib/api', () => ({ api: { resetPassword: vi.fn() } }))

const mockApi = api as unknown as { resetPassword: Mock }

const NEW = 'Prehnite!7712'
const TOKEN = 'reset-token'

const at = (state: unknown = { token: TOKEN }) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/reset', state }]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  )

const submit = async () => {
  await act(async () => {
    fireEvent.submit(document.querySelector('form')!)
  })
}

const fill = (confirm = NEW) => {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW } })
  fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: confirm } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.resetPassword.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('setting a password at the end of a recovery', () => {
  it('can show either box, independently', () => {
    at()
    const toggles = screen.getAllByRole('button', { name: 'Show password' })
    expect(toggles).toHaveLength(2)

    fireEvent.click(toggles[0])
    expect((screen.getByLabelText('New password') as HTMLInputElement).type).toBe('text')
    expect((screen.getByLabelText('Confirm') as HTMLInputElement).type).toBe('password')
  })

  it('tells a password manager both boxes are a new password', () => {
    at()
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Confirm')).toHaveAttribute('autocomplete', 'new-password')
  })

  it('opens focused on the first box', () => {
    at()
    expect(screen.getByLabelText('New password')).toHaveFocus()
  })

  it('still refuses two that do not match', async () => {
    at()
    fill('Prehnite!7721')
    await submit()

    expect(screen.getByText('Those two passwords do not match.')).toBeInTheDocument()
    expect(mockApi.resetPassword).not.toHaveBeenCalled()
  })

  it('spends the token from history state, with one password', async () => {
    at()
    fill()
    await submit()

    expect(mockApi.resetPassword).toHaveBeenCalledWith(TOKEN, NEW)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Password changed')
  })

  it('says a spent reset is spent, and keeps what was typed', async () => {
    // This works once. A refusal here means starting from the security question
    // again, so it must not read as the password having been rejected.
    mockApi.resetPassword.mockRejectedValue(new AppError('That reset link has been used.'))
    at()
    fill()
    await submit()

    expect(screen.getByText('That reset link has been used.')).toBeInTheDocument()
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe(NEW)
  })

  it('offers no form at all without a token', () => {
    at(null)
    expect(screen.queryByLabelText('New password')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Start from the beginning')
  })
})
