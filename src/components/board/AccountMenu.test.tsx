import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AccountMenu from './AccountMenu'
import { useAuthStore } from '../../store/authStore'

/**
 * A signed-in account, as the store now holds it.
 *
 * The store used to keep `email: string | null` and use it as the signed-in flag
 * too. An account can exist without an address now — a guest admitted by a join
 * code — so the flag is the presence of a user and the address is a field on it.
 */
const signedInUser = { id: 'u1', email: 'coach@example.com', displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: false, twoFactorEnabled: false }

/** A guest account: real, saving, and with no way back into it. */
const guestUser = { id: 'g1', email: null, displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: true, twoFactorEnabled: false }

/**
 * Three states, and the word "guest" moved between two of them.
 *
 * It used to mean "nobody is signed in", because that was the only way to use the
 * board without an account. A join code now admits somebody as a real account
 * with no address, so "guest" is a *kind of account* and the signed-out case is
 * just a visitor. Both still exist and they need opposite things said to them:
 * the visitor's board is not being saved, and the guest's board is — what the
 * guest lacks is any way back into the account holding it.
 *
 * The signed-out half of this file is the far end of the join-code carry, which
 * is still live for anyone who lands on `/board?join=CODE` without redeeming: the
 * toolbar hides "Join by code" from them and the board offers nothing else.
 */

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null })
})

const at = (entry: string) => {
  useAuthStore.setState({ user: null })
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AccountMenu />
    </MemoryRouter>,
  )
}

describe('AccountMenu for a signed-out visitor carrying a join code', () => {
  it('offers the way back to the board the code named', () => {
    at('/board?join=SLSDUB')
    expect(screen.getByRole('link', { name: 'Sign up and join' })).toHaveAttribute(
      'href',
      `/signup?next=${encodeURIComponent('/join?code=SLSDUB')}`,
    )
  })

  it('does not promise to save the board they are looking at', () => {
    at('/board?join=SLSDUB')
    expect(screen.queryByRole('link', { name: 'Save your board' })).toBeNull()
  })

  it('ignores something that is not a whole code', () => {
    at('/board?join=SLS')
    expect(screen.getByRole('link', { name: 'Save your board' })).toHaveAttribute('href', '/signup')
  })
})

describe('AccountMenu for an ordinary signed-out visitor', () => {
  it('is unchanged', () => {
    at('/board')
    expect(screen.getByRole('link', { name: 'Save your board' })).toHaveAttribute('href', '/signup')
    expect(screen.getByText('Not saving')).toBeInTheDocument()
  })
})

describe('AccountMenu for a guest account', () => {
  const asGuest = () => {
    useAuthStore.setState({ user: guestUser })
    return render(
      <MemoryRouter initialEntries={['/board']}>
        <AccountMenu />
      </MemoryRouter>,
    )
  }

  it('offers the way to keep the work, which is the whole mitigation', () => {
    // Guest admission would otherwise be a mechanism for losing boards: the
    // account has no password, so the cookie in this browser is the only route to
    // it. This control is the way out of that, so it is permanent rather than a
    // toast that fades after four seconds.
    asGuest()
    expect(screen.getByRole('link', { name: 'Keep these boards' })).toHaveAttribute(
      'href',
      '/claim',
    )
  })

  it('does not claim the board is unsaved, because it is saved', () => {
    // The opposite of what a signed-out visitor is told. This board really does
    // save, and "Not saving" here would be the indicator lying in the one place
    // a coach reads to ask the question.
    asGuest()
    expect(screen.queryByText('Not saving')).toBeNull()
    expect(screen.getByText('Guest')).toBeInTheDocument()
  })

  it('does not send them to signup, which would leave the boards behind', () => {
    // `/signup` makes a *second* account. The boards stay on the first one, which
    // is the failure this whole path exists to avoid.
    asGuest()
    expect(screen.queryByRole('link', { name: 'Save your board' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Sign up/ })).toBeNull()
  })

  it('is not offered the credential controls, because it has no credentials', async () => {
    // There is no password on this account to confirm, so "sign out everywhere"
    // has nothing to verify and nothing to revoke: a guest has exactly one
    // session, and it is the browser asking. The guest state has no popover at
    // all, which is what keeps both controls out of reach rather than each of
    // them remembering to check.
    asGuest()
    expect(screen.queryByRole('button', { name: /Account/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Sign out everywhere' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Change password' })).toBeNull()
  })
})

describe('AccountMenu for a signed-in account', () => {
  const openPopover = async (user = signedInUser) => {
    useAuthStore.setState({ user })
    render(
      <MemoryRouter initialEntries={['/board']}>
        <AccountMenu />
      </MemoryRouter>,
    )
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: /Account/ }), { button: 0 })
    })
  }

  it('offers a way to end every session that does not also change the password', async () => {
    // The gap this closes: until now the only control that signed every session
    // out was the one that made you invent a new password on the way. Somebody
    // who thinks a session has been taken should not have to.
    await openPopover()

    expect(screen.getByRole('link', { name: 'Sign out everywhere' })).toHaveAttribute(
      'href',
      '/sessions',
    )
    // Beside the password change rather than instead of it: they are different
    // requests and either one may be the one somebody wants.
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute(
      'href',
      '/password',
    )
  })

  it('offers the second factor, and says which state the account is in', async () => {
    // An invitation when it is off and a statement when it is on, so nobody is
    // asked to turn on something that is already on. The flag comes off the user
    // object the server builds from `totp_confirmed_at`, never from this side.
    await openPopover()
    expect(screen.getByRole('link', { name: 'Turn on two-step sign-in' })).toHaveAttribute(
      'href',
      '/2fa',
    )

    cleanup()
    await openPopover({ ...signedInUser, twoFactorEnabled: true })
    expect(screen.getByRole('link', { name: 'Two-step sign-in is on' })).toHaveAttribute(
      'href',
      '/2fa',
    )
  })

  it('shows the account rather than a way into one', () => {
    render(
      <MemoryRouter initialEntries={['/board?join=SLSDUB']}>
        <AccountMenu />
      </MemoryRouter>,
    )
    useAuthStore.setState({ user: signedInUser })
    cleanup()
    render(
      <MemoryRouter initialEntries={['/board?join=SLSDUB']}>
        <AccountMenu />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: 'Sign up and join' })).toBeNull()
    expect(screen.getByText('Account')).toBeInTheDocument()
  })
})
