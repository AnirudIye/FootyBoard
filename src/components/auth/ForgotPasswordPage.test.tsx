import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import ForgotPasswordPage from './ForgotPasswordPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'

/**
 * Recovering an account, and the step that was added between the answer and the
 * new password.
 *
 * `POST /api/auth/forgot/verify` used to trade a correct answer for a reset
 * token. For an account with a second factor it now trades it for a challenge
 * and **no token at all**, because the reset token is the credential: guarding
 * its use rather than its issue would put the code in front of something already
 * handed out.
 *
 * The consequence that has to be on screen before anybody spends an attempt is
 * the one nobody can undo. An account with the factor on, no authenticator and
 * no unused recovery codes cannot be recovered from this page by anyone, and
 * that is an accepted cost rather than a bug, which makes saying it out loud
 * part of the feature rather than a nicety.
 */

vi.mock('../../lib/api', () => ({
  api: {
    startPasswordRecovery: vi.fn(),
    verifySecurityAnswer: vi.fn(),
    completeRecoveryTwoFactor: vi.fn(),
  },
}))

const mockApi = api as unknown as {
  startPasswordRecovery: Mock
  verifySecurityAnswer: Mock
  completeRecoveryTwoFactor: Mock
}

/**
 * The token travels in history state rather than in the URL, because a query
 * string is written into the address bar, the history and any `Referer` the next
 * page sends. So the test has to read the state, not the path.
 */
function Where() {
  const l = useLocation()
  const token = (l.state as { token?: unknown } | null)?.token
  return <span data-testid="where">{`${l.pathname}|${String(token)}`}</span>
}

const at = () =>
  render(
    <MemoryRouter initialEntries={['/forgot']}>
      <ForgotPasswordPage />
      <Where />
    </MemoryRouter>,
  )

const where = () => screen.getByTestId('where').textContent
const said = () => document.body.textContent ?? ''

const submit = async () => {
  await act(async () => {
    fireEvent.submit(document.querySelector('form')!)
  })
}

const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

/** Address, then answer. Every test below starts from here. */
const answerTheQuestion = async () => {
  at()
  fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
    target: { value: 'coach@example.com' },
  })
  await submit()
  type(/^Answer/, 'Rusty')
  await submit()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.startPasswordRecovery.mockResolvedValue({
    question: { id: 'first-pet', label: 'What was your first pet called?' },
  })
})

afterEach(() => cleanup())

describe('an account with no second factor', () => {
  it('goes straight to the new password, exactly as it always did', async () => {
    mockApi.verifySecurityAnswer.mockResolvedValue({
      token: 'reset-token',
      challenge: null,
      expiresInMinutes: 15,
    })

    await answerTheQuestion()

    expect(where()).toBe('/reset|reset-token')
  })
})

describe('an account with a second factor', () => {
  beforeEach(() => {
    mockApi.verifySecurityAnswer.mockResolvedValue({
      token: null,
      challenge: { token: 'challenge-token', expiresInMinutes: 5 },
      expiresInMinutes: 15,
    })
    mockApi.completeRecoveryTwoFactor.mockResolvedValue({
      token: 'reset-token',
      expiresInMinutes: 15,
    })
  })

  it('asks for a code rather than moving on with nothing', async () => {
    await answerTheQuestion()

    // Navigating here would land on `/reset` with an undefined token, and that
    // page would render its "start from the beginning" branch at somebody who
    // has just answered their question correctly.
    expect(where()).toBe('/forgot|undefined')
    expect(screen.getByLabelText(/^Code/)).toBeInTheDocument()
  })

  it('says the thing nobody can undo before any attempt is spent', async () => {
    await answerTheQuestion()

    expect(said()).toMatch(/cannot skip this step/i)
    expect(said()).toMatch(/lost both/i)
    expect(said()).toMatch(/nobody can restore access/i)
    // And it is on screen with the field, not after a failure.
    expect(mockApi.completeRecoveryTwoFactor).not.toHaveBeenCalled()
  })

  it('trades the code for the reset token and carries it in history state', async () => {
    await answerTheQuestion()
    type(/^Code/, '123456')
    await submit()

    expect(mockApi.completeRecoveryTwoFactor).toHaveBeenCalledWith('challenge-token', '123456')
    expect(where()).toBe('/reset|reset-token')
  })

  it('sends a refused code back to the address rather than offering a retry', async () => {
    // The challenge is claimed before the code is compared, so one challenge is
    // worth one guess and a second attempt on the same token fails whatever is
    // typed. A retry box here would be a box that cannot work.
    mockApi.completeRecoveryTwoFactor.mockRejectedValue(
      new AppError('That code is not right. We cannot skip this step.'),
    )
    await answerTheQuestion()
    type(/^Code/, '000000')
    await submit()

    expect(screen.queryByLabelText(/^Code/)).toBeNull()
    expect(screen.getByPlaceholderText('name@example.com')).toBeInTheDocument()
    expect(said()).toMatch(/That code is not right\./)
    expect(said()).toMatch(/one attempt/i)
  })

  it('carries no em dash in any of it', async () => {
    await answerTheQuestion()
    expect(said()).not.toMatch(/—/)
  })
})
