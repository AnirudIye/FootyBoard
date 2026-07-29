import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AccountMenu from './AccountMenu'
import { useAuthStore } from '../../store/authStore'

/**
 * The other end of the carry.
 *
 * A guest who took the "continue as a guest" door out of the auth page arrives
 * here holding a code, and this menu is the only route back: the toolbar hides
 * "Join by code" from a guest, and a guest board offers nothing else. Landing
 * the auth page's half without this one would be the carry shipping dark, which
 * is a mistake this repo has made four times and written down.
 *
 * The label moves with the link on purpose. "Save your board" is the wrong
 * promise when signing up is going to open a different board.
 */

afterEach(() => {
  cleanup()
  useAuthStore.setState({ email: null })
})

const at = (entry: string) => {
  useAuthStore.setState({ email: null })
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AccountMenu />
    </MemoryRouter>,
  )
}

describe('AccountMenu for a guest carrying a join code', () => {
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

describe('AccountMenu for an ordinary guest', () => {
  it('is unchanged', () => {
    at('/board')
    expect(screen.getByRole('link', { name: 'Save your board' })).toHaveAttribute('href', '/signup')
    expect(screen.getByText('Not saving')).toBeInTheDocument()
  })
})

describe('AccountMenu for a signed-in account', () => {
  it('shows the account rather than a way into one', () => {
    render(
      <MemoryRouter initialEntries={['/board?join=SLSDUB']}>
        <AccountMenu />
      </MemoryRouter>,
    )
    useAuthStore.setState({ email: 'coach@example.com' })
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
