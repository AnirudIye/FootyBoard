import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import AuthPage from './AuthPage'
import { useAuthStore } from '../../store/authStore'

/**
 * The three doors off the auth page, and what each one does with a pending
 * join code.
 *
 * Two of them were already right: submitting the form honours `next`, in both
 * modes, and `next` rides across the link between them. The third was not.
 * "Continue as a guest" was a bare `/board`, so somebody who typed a code, was
 * asked for an account and decided they did not want one landed on a blank
 * board with the code gone and nothing said about it. A guest cannot redeem a
 * code, because membership attaches to a person rather than to a browser, so
 * the fix is not guest redemption: it is that the door says what it costs and
 * does not throw away what was typed on the way through.
 *
 * These assert on the rendered page rather than on any helper, because the
 * defect was entirely in what the page offered.
 */

vi.mock('../../lib/api', () => ({
  api: {
    securityQuestions: vi
      .fn()
      .mockResolvedValue({ questions: [{ id: 'first-pet', label: 'First pet?' }] }),
  },
}))

const NEXT = '/join?code=SLSDUB'
const ENTRY = `/login?next=${encodeURIComponent(NEXT)}`

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

const at = (entry: string, mode: 'login' | 'signup' = 'login') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthPage mode={mode} />
      <Where />
    </MemoryRouter>,
  )

const guestDoor = () => screen.getByRole('link', { name: 'Continue as a guest' })
/** The whole sentence around the guest link, which is where the cost is said. */
const guestCopy = () => guestDoor().closest('p')!.textContent ?? ''

const real = { signUp: useAuthStore.getState().signUp, logIn: useAuthStore.getState().logIn }

beforeEach(() => {
  useAuthStore.setState({
    email: null,
    signUp: vi.fn().mockResolvedValue(undefined),
    logIn: vi.fn().mockResolvedValue(undefined),
  })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ email: null, ...real })
  vi.clearAllMocks()
})

const submit = async () => {
  const form = document.querySelector('form')!
  await act(async () => {
    fireEvent.submit(form)
  })
}

const fill = () => {
  fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
    target: { value: 'coach@example.com' },
  })
  const password = document.querySelector('input[type="password"]')!
  fireEvent.change(password, { target: { value: 'Prehnite!7712' } })
}

describe('AuthPage with a join code pending', () => {
  it('does not throw the code away when someone continues as a guest', () => {
    at(ENTRY)
    // The defect: a bare `/board`, so the code the person typed a moment ago
    // reached nothing and nothing said so.
    expect(guestDoor()).toHaveAttribute('href', '/board?join=SLSDUB')
  })

  it('says plainly what continuing as a guest costs', () => {
    at(ENTRY)
    const copy = guestCopy()
    expect(copy).toMatch(/needs an account/i)
    expect(copy).toMatch(/never saved/i)
    expect(copy).toMatch(/do not join the one you were opening/i)
    // And that the code survives, which is the whole reason the door may stay.
    expect(copy).toMatch(/code comes with you/i)
  })

  it('carries the code across the switch to the signup form', () => {
    at(ENTRY)
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute(
      'href',
      `/signup?next=${encodeURIComponent(NEXT)}`,
    )
  })

  it('lands a returning account on the board the code named', async () => {
    at(ENTRY)
    fill()
    await submit()
    expect(useAuthStore.getState().logIn).toHaveBeenCalledWith(
      'coach@example.com',
      'Prehnite!7712',
    )
    expect(screen.getByTestId('where')).toHaveTextContent(NEXT)
  })

  it('lands a brand new account on the board the code named', async () => {
    at(`/signup?next=${encodeURIComponent(NEXT)}`, 'signup')
    fill()
    await submit()
    expect(useAuthStore.getState().signUp).toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent(NEXT)
  })
})

describe('AuthPage with nothing pending', () => {
  it('leaves the ordinary guest door exactly as it was', () => {
    at('/login')
    expect(guestDoor()).toHaveAttribute('href', '/board')
    expect(guestCopy()).toBe('Continue as a guest for a full board that is never saved.')
  })

  it('sends an ordinary sign-in to the board', async () => {
    at('/login')
    fill()
    await submit()
    expect(screen.getByTestId('where')).toHaveTextContent('/board')
  })
})

describe('AuthPage and a next that only looks like a join', () => {
  it('does not read a code out of a different path', () => {
    at(`/login?next=${encodeURIComponent('/joinery?code=SLSDUB')}`)
    expect(guestDoor()).toHaveAttribute('href', '/board')
  })

  it('treats half a code as no code', () => {
    at(`/login?next=${encodeURIComponent('/join?code=SLS')}`)
    expect(guestDoor()).toHaveAttribute('href', '/board')
    expect(guestCopy()).toBe('Continue as a guest for a full board that is never saved.')
  })
})

describe('AuthPage with a share link pending', () => {
  /**
   * The same screen is where a share *link* sends a signed-out visitor, so the
   * same door dropped the same way in. The token is a credential rather than
   * six letters read off a screen, so it is deliberately not carried: putting
   * it back in the address bar is what `useShareLink` strips it to avoid, and
   * a guest sent to `/board?share=…` would only be bounced straight back here.
   * Being told is the whole of the fix for this one.
   */
  const shareEntry = `/login?next=${encodeURIComponent('/board?share=tok_abcdef')}`

  it('says the guest board is not the board they were opening', () => {
    at(shareEntry)
    expect(guestCopy()).toMatch(/needs an account/i)
    expect(guestCopy()).toMatch(/do not join the one you were opening/i)
  })

  it('does not put the share token back in a URL', () => {
    at(shareEntry)
    expect(guestDoor()).toHaveAttribute('href', '/board')
    expect(guestDoor().getAttribute('href')).not.toContain('tok_abcdef')
  })
})

describe('AuthPage and an off-site next', () => {
  /** `next` comes from the URL, so anyone can put anything in it. */
  const entry = `/login?next=${encodeURIComponent('https://evil.example/login')}`

  it('refuses to follow it after signing in', async () => {
    at(entry)
    fill()
    await submit()
    expect(screen.getByTestId('where')).toHaveTextContent('/board')
  })

  it('refuses to put it on the guest door', () => {
    at(entry)
    expect(guestDoor()).toHaveAttribute('href', '/board')
  })

  it('refuses a protocol-relative one', () => {
    at(`/login?next=${encodeURIComponent('//evil.example')}`)
    expect(guestDoor()).toHaveAttribute('href', '/board')
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup')
  })
})
