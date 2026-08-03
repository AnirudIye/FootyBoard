import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import TwoFactorPage from './TwoFactorPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'

/**
 * Turning the second factor on, and the two things this page must not get
 * wrong.
 *
 * **The ten recovery codes are said exactly once**, in the reply to
 * `/2fa/confirm`, and no endpoint will ever hand them back. So the page has to
 * hold them for the life of the render and say plainly that this is the only
 * showing; a page that let them scroll off, or that implied they could be
 * fetched again, would be handing somebody a locked account in a fortnight.
 *
 * **A guest cannot have a factor at all.** `assertCurrentPassword` refuses one by
 * name, so `/2fa/enroll` answers 400 with `field: 'currentPassword'` and a
 * message about having no password to check. Showing a guest a password box and
 * letting the server say that is a dead end; the page sends them where the
 * answer is, exactly as `/password` and `/sessions` already do.
 */

vi.mock('../../lib/api', () => ({
  api: {
    me: vi.fn(),
    twoFactorStatus: vi.fn(),
    beginTwoFactorEnrollment: vi.fn(),
    confirmTwoFactorEnrollment: vi.fn(),
    disableTwoFactor: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
  },
}))

const mockApi = api as unknown as {
  me: Mock
  twoFactorStatus: Mock
  beginTwoFactorEnrollment: Mock
  confirmTwoFactorEnrollment: Mock
  disableTwoFactor: Mock
  regenerateRecoveryCodes: Mock
}

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

/** Ten, in the shape the server formats them: four groups of four. */
const CODES = [
  'ABCD-EFGH-JKLM-NPQR',
  'BCDE-FGHJ-KLMN-PQRS',
  'CDEF-GHJK-LMNP-QRST',
  'DEFG-HJKL-MNPQ-RSTU',
  'EFGH-JKLM-NPQR-STUV',
  'FGHJ-KLMN-PQRS-TUVW',
  'GHJK-LMNP-QRST-UVWX',
  'HJKL-MNPQ-RSTU-VWXY',
  'JKLM-NPQR-STUV-WXYZ',
  'KLMN-PQRS-TUVW-XYZA',
]

const signedIn = {
  id: 'u1',
  email: 'coach@example.com',
  displayName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  isGuest: false,
  twoFactorEnabled: false,
}
const guest = { ...signedIn, id: 'g1', email: null, isGuest: true }

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

const at = async () => {
  const result = render(
    <MemoryRouter initialEntries={['/2fa']}>
      <TwoFactorPage />
      <Where />
    </MemoryRouter>,
  )
  // The status fetch runs in an effect, so the first paint is the loading state.
  await act(async () => {})
  return result
}

const where = () => screen.getByTestId('where').textContent
const said = () => document.body.textContent ?? ''

const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

const press = async (name: RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // The real `restore` runs after anything that changes the factor, so the
  // account menu is not left offering to turn on something already on.
  mockApi.me.mockResolvedValue({ user: signedIn })
  mockApi.twoFactorStatus.mockResolvedValue({ enabled: false, remainingRecoveryCodes: 0 })
  mockApi.beginTwoFactorEnrollment.mockResolvedValue({
    secret: SECRET,
    uri: `otpauth://totp/FootyBoard:coach@example.com?secret=${SECRET}&issuer=FootyBoard`,
  })
  mockApi.confirmTwoFactorEnrollment.mockResolvedValue({ recoveryCodes: CODES })
  mockApi.disableTwoFactor.mockResolvedValue({ ok: true })
  mockApi.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: CODES })
  useAuthStore.setState({ user: signedIn, ready: true })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ready: false })
})

describe('who may reach the page', () => {
  it('sends a visitor to sign in, and back here afterwards', async () => {
    useAuthStore.setState({ user: null, ready: true })
    await at()

    expect(where()).toBe('/login?next=/2fa')
  })

  it('sends a guest to claiming their account instead of showing a password box', async () => {
    // A guest has no password, so the factor cannot sit behind one. The server
    // refuses `/2fa/enroll` for exactly this reason; the page does not make them
    // find that out by typing.
    useAuthStore.setState({ user: guest, ready: true })
    await at()

    expect(where()).toBe('/claim')
    expect(mockApi.twoFactorStatus).not.toHaveBeenCalled()
  })

  it('waits until the session has been checked before deciding either', async () => {
    useAuthStore.setState({ user: null, ready: false })
    await at()

    expect(where()).toBe('/2fa')
  })
})

describe('looking at the password this page keeps asking for', () => {
  const reveal = () => fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
  const box = () => screen.getByLabelText(/current password/i) as HTMLInputElement

  it('can be shown on the form that turns the factor on', async () => {
    await at()
    type(/current password/i, 'the-real-password')
    reveal()

    expect(box().type).toBe('text')
    expect(box().value).toBe('the-real-password')
  })

  it('can be shown on the form that takes a factor away', async () => {
    mockApi.twoFactorStatus.mockResolvedValue({ enabled: true, remainingRecoveryCodes: 7 })
    await at()
    await press(/^Turn off two-step sign-in$/)
    type(/current password/i, 'the-real-password')
    reveal()

    expect(box().type).toBe('text')
  })

  it('reads its explanation out as a description rather than as the field name', async () => {
    // The sentence under this box used to sit inside the `<label>`, so it was
    // part of the input's accessible name: a screen reader read the whole
    // explanation as the title of the field every time focus landed on it.
    await at()

    expect(box()).toHaveAccessibleName('Current password')
    expect(box()).toHaveAccessibleDescription(/cannot attach their app/i)
  })
})

describe('turning it on', () => {
  it('offers the enrollment form when the factor is off', async () => {
    await at()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Two-step sign-in')
    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument()
    expect(said()).toMatch(/security question/i)
  })

  it('shows the secret and a link the phone can open', async () => {
    await at()
    type(/current password/i, 'the-real-password')
    await press(/^Set this up$/)

    expect(mockApi.beginTwoFactorEnrollment).toHaveBeenCalledWith('the-real-password')
    // In groups of four, because 32 characters retyped from a screen is the
    // worst moment in this feature and an unbroken run of them is worse.
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /authenticator app/i })).toHaveAttribute(
      'href',
      expect.stringContaining('otpauth://totp/'),
    )
  })

  it('shows all ten codes once, and says that is the only time', async () => {
    await at()
    type(/current password/i, 'the-real-password')
    await press(/^Set this up$/)
    type(/^Code/, '123456')
    await press(/^Finish/)

    expect(mockApi.confirmTwoFactorEnrollment).toHaveBeenCalledWith('123456')
    for (const code of CODES) expect(screen.getByText(code)).toBeInTheDocument()
    expect(said()).toMatch(/only time they are shown/i)
    expect(said()).toMatch(/each one works once/i)
  })

  it('asks the server who we are again, so the account menu stops offering it', async () => {
    // `twoFactorEnabled` is decided from `totp_confirmed_at` server-side. Writing
    // it here would be a second place that decides what "on" means, and leaving
    // it stale means the popover goes on offering to turn on a live factor.
    mockApi.me.mockResolvedValue({ user: { ...signedIn, twoFactorEnabled: true } })
    await at()
    type(/current password/i, 'the-real-password')
    await press(/^Set this up$/)
    type(/^Code/, '123456')
    await press(/^Finish/)

    expect(useAuthStore.getState().user?.twoFactorEnabled).toBe(true)
  })

  it('keeps the person on the code step when the code is refused', async () => {
    // Unlike the sign-in form. `/2fa/confirm` compares against a secret this
    // person generated a moment ago, so there is no challenge to burn and no
    // reason to make them start the enrollment again over a typo.
    mockApi.confirmTwoFactorEnrollment.mockRejectedValue(
      new AppError('That code is not right. Check your authenticator app and try again.'),
    )
    await at()
    type(/current password/i, 'the-real-password')
    await press(/^Set this up$/)
    type(/^Code/, '000000')
    await press(/^Finish/)

    expect(screen.getByLabelText(/^Code/)).toBeInTheDocument()
    expect(said()).toMatch(/That code is not right\./)
  })
})

describe('when it is already on', () => {
  it('says how many ways back in are left', async () => {
    mockApi.twoFactorStatus.mockResolvedValue({ enabled: true, remainingRecoveryCodes: 7 })
    await at()

    expect(said()).toMatch(/7 recovery codes left/i)
  })

  it('says the strongest thing on the screen when there are none left', async () => {
    // Zero unused codes plus a lost phone is the case that needs an operator,
    // and the accepted cost of that is only acceptable if it can be seen coming.
    mockApi.twoFactorStatus.mockResolvedValue({ enabled: true, remainingRecoveryCodes: 0 })
    await at()

    expect(said()).toMatch(/no recovery codes left/i)
    expect(said()).toMatch(/nobody can restore access/i)
  })

  it('asks for the password and a code before turning it off', async () => {
    mockApi.twoFactorStatus.mockResolvedValue({ enabled: true, remainingRecoveryCodes: 7 })
    await at()
    await press(/^Turn off two-step sign-in$/)

    type(/current password/i, 'the-real-password')
    type(/^Code/, '123456')
    await press(/^Turn it off$/)

    expect(mockApi.disableTwoFactor).toHaveBeenCalledWith('the-real-password', '123456')
    expect(said()).toMatch(/two-step sign-in is off/i)
  })

  it('replaces all ten codes and shows the new set', async () => {
    mockApi.twoFactorStatus.mockResolvedValue({ enabled: true, remainingRecoveryCodes: 2 })
    await at()
    await press(/^Get a new set of recovery codes$/)

    type(/current password/i, 'the-real-password')
    type(/^Code/, '123456')
    await press(/^Replace them$/)

    expect(mockApi.regenerateRecoveryCodes).toHaveBeenCalledWith('the-real-password', '123456')
    for (const code of CODES) expect(screen.getByText(code)).toBeInTheDocument()
    expect(said()).toMatch(/only time they are shown/i)
  })
})

describe('the copy', () => {
  it('carries no em dash in any state it can be in', async () => {
    await at()
    expect(said()).not.toMatch(/—/)

    type(/current password/i, 'the-real-password')
    await press(/^Set this up$/)
    expect(said()).not.toMatch(/—/)

    type(/^Code/, '123456')
    await press(/^Finish/)
    expect(said()).not.toMatch(/—/)
  })
})
