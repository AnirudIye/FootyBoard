import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import AuthPage from './AuthPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'

/**
 * The three doors off the auth page, and what each one does with a pending
 * join code.
 *
 * Two of them were always right: submitting the form honours `next`, in both
 * modes, and `next` rides across the link between them. The third has been wrong
 * twice, in two different ways.
 *
 * First it was a bare `/board`, so somebody who typed a code, was asked for an
 * account and decided they did not want one landed on a blank board with the
 * code gone and nothing said about it. That was fixed by carrying the code to
 * `/board?join=CODE` and saying what the door cost, on the argument that a guest
 * *cannot* redeem a code because membership attaches to a person rather than a
 * browser.
 *
 * That argument was wrong, and this is the second fix. `POST /api/auth/signup`
 * verifies no address at all, so the account gate stopped nobody who wanted
 * through it: it was a constraint on the users table, not a barrier. A guest gets
 * an account now, with no address and no password, and real membership of the
 * board the code names. So the door goes where the person was trying to go, and
 * what it has to say plainly is the new cost: the account holding their work has
 * no password yet.
 *
 * A share *link* used to be refused here, and that was the third fix. The
 * argument was that a token is a credential and there is no redeeming one
 * without an account that does not put it back in a URL — but it is already in a
 * URL, because that is what a share link is, and the person arrived holding it
 * in `next`. Refusing them unsent nothing. What it produced was "continue as a
 * guest" handing them a blank board of their own while the shared board never
 * opened: no error, and every appearance of having worked. The same reasoning
 * that corrected the code door applies unchanged, so both doors now redeem.
 *
 * These assert on the rendered page rather than on any helper, because all three
 * defects were entirely in what the page offered.
 */

vi.mock('../../lib/api', () => ({
  api: {
    securityQuestions: vi
      .fn()
      .mockResolvedValue({ questions: [{ id: 'first-pet', label: 'First pet?' }] }),
    joinAsGuest: vi.fn(),
    redeemShareAsGuest: vi.fn(),
    me: vi.fn(),
  },
}))

const mockApi = api as unknown as {
  joinAsGuest: Mock
  redeemShareAsGuest: Mock
  me: Mock
}

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

/**
 * The guest door, whichever kind it is on this page.
 *
 * With a code pending it is a button, because it performs a redemption rather
 * than navigating. Without one it is still a link to a board of your own. Looked
 * up by name across both roles on purpose: what matters to somebody reading the
 * page is that the door is there and says the same thing, not which element it
 * happens to be.
 */
/** Found by its words rather than its role, which is the part that changes. */
const guestDoor = () => screen.getByText('Continue as a guest')
const guestButton = () => screen.getByRole('button', { name: 'Continue as a guest' })
/** The whole sentence around the guest door, which is where the cost is said. */
const guestCopy = () => guestDoor().closest('p')!.textContent ?? ''

const GUEST = { id: 'g1', email: null, displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: true, twoFactorEnabled: false }

const real = {
  signUp: useAuthStore.getState().signUp,
  logIn: useAuthStore.getState().logIn,
  completeTwoFactor: useAuthStore.getState().completeTwoFactor,
  restore: useAuthStore.getState().restore,
}

beforeEach(() => {
  useAuthStore.setState({
    user: null,
    signUp: vi.fn().mockResolvedValue(undefined),
    /**
     * Null, because this stands in for the **store action** rather than for the
     * API call behind it. `authStore.logIn` narrows `{ user, challenge }` down to
     * the challenge alone and signs the user in itself when there is none, so
     * null here is an ordinary account signing straight in, which is every test
     * in this file except the second-factor block below. Resolving the whole
     * response shape would be truthy and would hold every one of them on a code
     * step that does not exist.
     */
    logIn: vi.fn().mockResolvedValue(null),
    completeTwoFactor: vi.fn().mockResolvedValue(undefined),
    // The real `restore`, so the store really does end up holding a guest rather
    // than a test double asserting that a stub was called.
    restore: real.restore,
  })
  mockApi.joinAsGuest.mockResolvedValue({ board: { id: 'shared-board', name: 'Session board' } })
  mockApi.redeemShareAsGuest.mockResolvedValue({
    board: { id: 'linked-board', name: 'Linked session' },
  })
  mockApi.me.mockResolvedValue({ user: GUEST })
  useBoardsStore.setState({ boards: [], currentId: null, nextCursor: null, saveState: 'idle' })
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ...real })
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
  it('takes the guest to the board the code names', async () => {
    // Two defects deep. It was a bare `/board`, which lost the code; then it was
    // `/board?join=CODE`, which kept the code and still left the person on a
    // blank board of their own rather than the one they were told to open.
    at(ENTRY)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(mockApi.joinAsGuest).toHaveBeenCalledWith('SLSDUB')
    expect(screen.getByTestId('where')).toHaveTextContent('/board')
    // And the board it opens is the one the code named, not whatever was last
    // open. Selecting it is what the board page reads.
    expect(useBoardsStore.getState().currentId).toBe('shared-board')
  })

  it('is signed in as the guest before the board page is reached', async () => {
    // The order is load-bearing. The redeem response carries the session cookie,
    // but the rest of the app learns it is signed in from `restore`; navigating
    // first means the board page mounts as nobody and loads nothing.
    at(ENTRY)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(mockApi.me).toHaveBeenCalled()
    expect(useAuthStore.getState().user?.isGuest).toBe(true)
  })

  it('says plainly what continuing as a guest now costs', async () => {
    at(ENTRY)
    const copy = guestCopy()
    // The old cost was "you do not join the board". The new one is different and
    // has to be said just as plainly: the work is saved, and the account holding
    // it has no password yet.
    expect(copy).toMatch(/straight to the board/i)
    expect(copy).toMatch(/saved/i)
    expect(copy).toMatch(/no password/i)
    expect(copy).toMatch(/this browser/i)
    // And it must not still be claiming the old behaviour.
    expect(copy).not.toMatch(/do not join the one you were opening/i)
  })

  it('says so and stays put when the code turns out not to work', async () => {
    // A code can expire between being read out and being typed. Landing the
    // person on a blank board without a word is what the first version of this
    // did; the page has to keep them here and say why.
    mockApi.joinAsGuest.mockRejectedValue(new AppError('That code has expired.'))
    at(ENTRY)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    // Still on the auth page, code still in `next`, so the other two doors are
    // right there: sign in, or make an account, without retyping anything.
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/login?next=%2Fjoin%3Fcode%3DSLSDUB',
    )
    expect(screen.getByText('That code has expired.')).toBeTruthy()
    expect(useAuthStore.getState().user).toBeNull()
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
   * The same screen is where a share *link* sends a signed-out visitor, and the
   * door used to drop them the same way the code door once did — onto a blank
   * board of their own, with the shared board never opened and nothing said.
   *
   * The reported symptom was exactly that, and the reason it was reported rather
   * than noticed is that it looks like success: a board appears, it works, and
   * only the person who sent the link ever finds out it was the wrong one.
   */
  const TOKEN = 'tok_abcdef'
  const shareEntry = `/login?next=${encodeURIComponent(`/board?board=b1&share=${TOKEN}`)}`

  it('takes the guest to the board the link opens', async () => {
    at(shareEntry)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(mockApi.redeemShareAsGuest).toHaveBeenCalledWith(TOKEN)
    expect(screen.getByTestId('where')).toHaveTextContent('/board')
    expect(useBoardsStore.getState().currentId).toBe('linked-board')
  })

  it('redeems the link rather than the code path', async () => {
    // The two doors are one button and pick their call from `next`. Sending a
    // share token to `joinAsGuest` would be a 404 that reads like a dead link.
    at(shareEntry)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(mockApi.redeemShareAsGuest).toHaveBeenCalledTimes(1)
    expect(mockApi.joinAsGuest).not.toHaveBeenCalled()
  })

  it('is signed in as the guest before the board page is reached', async () => {
    at(shareEntry)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(mockApi.me).toHaveBeenCalled()
    expect(useAuthStore.getState().user?.isGuest).toBe(true)
  })

  it('does not put the share token back in a URL', async () => {
    // The reason `useShareLink` strips it, and the reason the old refusal
    // existed. Redeeming has to end somewhere clean, or the token survives in
    // history and gets handed straight back to be redeemed a second time.
    at(shareEntry)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    const where = screen.getByTestId('where').textContent ?? ''
    expect(where).toBe('/board')
    expect(where).not.toContain(TOKEN)
  })

  it('says plainly what continuing as a guest costs, and no longer says it fails', async () => {
    at(shareEntry)
    const copy = guestCopy()

    expect(copy).toMatch(/board the link opens/i)
    expect(copy).toMatch(/no password/i)
    // The two sentences the old refusal used. Their absence is the fix.
    expect(copy).not.toMatch(/needs an account/i)
    expect(copy).not.toMatch(/do not join the one you were opening/i)
  })

  it('is a button now, not a link to a board of your own', () => {
    at(shareEntry)
    // It performs a redemption, so it cannot be an anchor to `/board`. The old
    // one was, and that anchor *was* the bug.
    expect(guestButton()).toBeInTheDocument()
    expect(guestDoor()).not.toHaveAttribute('href')
  })

  it('says a dead link is dead, and lets them try another door', async () => {
    mockApi.redeemShareAsGuest.mockRejectedValueOnce(
      new AppError('That link is not valid any more.'),
    )
    at(shareEntry)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(await screen.findByText(/not valid any more/i)).toBeInTheDocument()
    // Still on the auth page, with the door usable again: a revoked link is the
    // one case where signing in properly is the actual answer, and the form is
    // right there.
    expect(screen.getByTestId('where')).not.toHaveTextContent('/board')
    expect(guestButton()).not.toBeDisabled()
  })

  it('carries a token through `next` unmangled, whatever is in it', async () => {
    // `next` is percent-encoded, so a token with URL-significant bytes arrives
    // escaped and has to be handed to the server as the original.
    const awkward = 'a+b/c=d'
    const entry = `/login?next=${encodeURIComponent(`/board?share=${encodeURIComponent(awkward)}`)}`
    at(entry)
    await act(async () => {
      fireEvent.click(guestButton())
    })

    expect(mockApi.redeemShareAsGuest).toHaveBeenCalledWith(awkward)
  })

  it('still honours `next` when they sign in properly instead', async () => {
    // The other two doors are unchanged, and this is the one that puts the token
    // back in the address bar on purpose — for `useShareLink` to redeem and then
    // strip, which is the signed-in journey and was never broken.
    at(shareEntry)
    fill()
    await submit()

    expect(screen.getByTestId('where')).toHaveTextContent(TOKEN)
  })
})

/**
 * The second step, and the one thing about it that could not be papered over.
 *
 * `POST /api/auth/login/2fa` **claims the challenge before it compares the
 * code**, so one challenge buys exactly one guess and a wrong code cannot be
 * retried on the same token. A page that answered a refusal by leaving the code
 * field on screen would be offering a box that fails every time however right
 * the next code is, and the person would conclude their authenticator is broken.
 *
 * So the refusal goes back to the password step and says why. That is a cost of
 * the server's design rather than a decision this page gets to make, which is
 * exactly why it is asserted here rather than left to be discovered.
 */
describe('AuthPage when the account has a second factor', () => {
  const CHALLENGE = { token: 'challenge-token', expiresInMinutes: 5 }

  /**
   * Anchored at the start rather than matched whole. The hint under the field
   * sits inside the label, exactly as it does for the display name and the
   * security answer, so the input's accessible name is the label plus that
   * sentence.
   */
  const CODE_LABEL = /^Code/

  const withChallenge = () => {
    useAuthStore.setState({ logIn: vi.fn().mockResolvedValue(CHALLENGE) })
  }

  const codeField = () => screen.getByLabelText(CODE_LABEL)

  const submitCode = async (code: string) => {
    fireEvent.change(codeField(), { target: { value: code } })
    await submit()
  }

  it('asks for the code rather than signing anybody in', async () => {
    withChallenge()
    at('/login')
    fill()
    await submit()

    // No session exists at this point on the server either, so navigating to the
    // board would mount a page that loads nothing and bounces straight back.
    expect(screen.getByTestId('where')).toHaveTextContent('/login')
    expect(codeField()).toBeInTheDocument()
    // And the credentials are gone from the screen, so this reads as one step of
    // a sign-in rather than a form that failed and kept everything.
    expect(screen.queryByPlaceholderText('name@example.com')).toBeNull()
  })

  it('spends the challenge token and then honours next', async () => {
    withChallenge()
    at(ENTRY)
    fill()
    await submit()
    await submitCode('123456')

    expect(useAuthStore.getState().completeTwoFactor).toHaveBeenCalledWith(
      'challenge-token',
      '123456',
    )
    expect(screen.getByTestId('where')).toHaveTextContent(NEXT)
  })

  it('sends a refused code back to the password step instead of offering a retry', async () => {
    withChallenge()
    useAuthStore.setState({
      completeTwoFactor: vi.fn().mockRejectedValue(new AppError('That code is not right.')),
    })
    at('/login')
    fill()
    await submit()
    await submitCode('000000')

    // The token is spent, so a second attempt on it is refused whatever is
    // typed. Leaving the field on screen would be a box that cannot ever work.
    expect(screen.queryByLabelText(CODE_LABEL)).toBeNull()
    expect(screen.getByPlaceholderText('name@example.com')).toBeInTheDocument()

    const said = document.body.textContent ?? ''
    expect(said).toMatch(/That code is not right\./)
    // And it says why the form moved, which is the part nobody could infer.
    expect(said).toMatch(/one attempt/i)
  })

  it('carries no em dash in any of it', async () => {
    withChallenge()
    at('/login')
    fill()
    await submit()

    expect(document.body.textContent ?? '').not.toMatch(/—/)
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
