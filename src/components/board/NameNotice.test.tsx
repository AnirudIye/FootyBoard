import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NameNotice from './NameNotice'
import { useAuthStore } from '../../store/authStore'
import { useNameNoticeStore } from '../../store/nameNoticeStore'

/**
 * The line that tells somebody what the room is calling them.
 *
 * The condition is the whole of this component, and getting it wrong in either
 * direction is worse than not having it: shown to a guest it warns about a
 * disclosure that cannot happen, and shown to somebody who has a name it is
 * simply noise on their board forever.
 */

const account = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'coach@example.com',
  displayName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  isGuest: false,
  twoFactorEnabled: false,
  ...over,
})

const show = () =>
  render(
    <MemoryRouter>
      <NameNotice />
    </MemoryRouter>,
  )

beforeEach(() => {
  localStorage.clear()
  useNameNoticeStore.setState({ noticeDismissed: false })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null })
})

describe('NameNotice', () => {
  it('tells an account with an address and no name what the room calls them', () => {
    useAuthStore.setState({ user: account() })
    show()

    // The local part, which is exactly what `identity()` discloses.
    expect(screen.getByText('coach')).toBeTruthy()
    expect(screen.getByRole('link', { name: /choose a name/i })).toBeTruthy()
  })

  it('says nothing to somebody who has already chosen one', () => {
    useAuthStore.setState({ user: account({ displayName: 'Coach Ellis' }) })
    const { container } = show()

    expect(container.textContent).toBe('')
  })

  /**
   * A guest's display name is null too, which is why the condition cannot be
   * "no display name". They have no address to disclose, so the room already
   * calls them Anonymous Something and this warning would be false.
   */
  it('says nothing to a guest, who has no address to disclose', () => {
    useAuthStore.setState({ user: account({ id: 'g1', email: null, isGuest: true }) })
    const { container } = show()

    expect(container.textContent).toBe('')
  })

  it('says nothing to a visitor who is not signed in at all', () => {
    useAuthStore.setState({ user: null })
    const { container } = show()

    expect(container.textContent).toBe('')
  })

  it('goes away when it is dismissed, and stays away next time', () => {
    useAuthStore.setState({ user: account() })
    const first = show()
    fireEvent.click(screen.getByRole('button', { name: /got it/i }))
    expect(first.container.textContent).toBe('')

    cleanup()
    // A fresh store reading the same storage is what the next session is.
    useNameNoticeStore.setState({
      noticeDismissed: localStorage.getItem('soccerboard.displayName.notice') === '1',
    })
    const second = show()
    expect(second.container.textContent).toBe('')
  })
})
