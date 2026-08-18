import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import AuthPage from './AuthPage'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'
import { PAGES } from '../../content/marketing.js'

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

const PASSWORD = 'Prehnite!7712'

/**
 * Anchored on the labels rather than on `input[type="password"]`, which is the
 * selector this used to use and which stopped meaning "the password box" twice
 * over: a revealed field is `type="text"`, and signup has two of them.
 */
const fill = (password = PASSWORD, confirm = password) => {
  fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
    target: { value: 'coach@example.com' },
  })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  // Only signup has one, and a login test asking for it would be asserting the
  // form has a field it must not have.
  const second = screen.queryByLabelText('Confirm')
  if (second) fireEvent.change(second, { target: { value: confirm } })
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

  /**
   * The ones a first-character check waves through, and a URL parser does not.
   *
   * `startsWith('/') && !startsWith('//')` is not the test a browser runs. A
   * browser reads a backslash as a slash, and the WHATWG URL parser strips a
   * tab, a newline or a carriage return wherever it sits — so each value below
   * looks like a rooted local path to the string check and resolves to a
   * different origin. Proven against the parser this environment ships:
   * `new URL('/\\evil.example', ourOrigin).origin` is `evil.example`, not ours.
   *
   * The property asserted is the one that matters after sign-in: a hostile
   * `next` must not become the place `navigate` sends the person, and must not
   * be carried forward on the link to the other form. Both fall back to the
   * default instead.
   */
  const disguised = [
    ['a backslash standing in for the slash', '/\\evil.example'],
    ['a backslash then a slash', '/\\/evil.example'],
    ['a tab smuggled into the path', '/\t/evil.example'],
    ['a newline smuggled into the path', '/\n/evil.example'],
    ['a carriage return before a double slash', '/\r//evil.example'],
  ] as const

  for (const [label, value] of disguised) {
    it(`refuses ${label} after signing in`, async () => {
      at(`/login?next=${encodeURIComponent(value)}`)
      fill()
      await submit()
      // Lands on the default post-login page, not the disguised origin.
      expect(screen.getByTestId('where')).toHaveTextContent('/board')
      expect(screen.getByTestId('where')).not.toHaveTextContent('evil.example')
    })

    it(`keeps ${label} off the switch link`, () => {
      at(`/login?next=${encodeURIComponent(value)}`)
      // A rejected `next` is dropped, so the link to the other form is bare.
      expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup')
    })
  }
})

/**
 * Seeing what you typed, on both doors.
 *
 * The component's own behaviour is asserted in `PasswordField.test.tsx`. What is
 * here is that this page uses it, in both modes, and that a form submitted with
 * the password on screen still submits the password.
 */
describe('AuthPage and the password you cannot see', () => {
  const reveal = () => fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0])

  it('conceals it until it is asked', () => {
    at('/login')
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password')
  })

  it('shows it on the sign-in form', () => {
    at('/login')
    fill()
    reveal()

    const box = screen.getByLabelText('Password') as HTMLInputElement
    expect(box.type).toBe('text')
    expect(box.value).toBe(PASSWORD)
  })

  it('shows it on the signup form', () => {
    at('/signup', 'signup')
    reveal()
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text')
  })

  it('keeps the hint a password manager reads, which is different on each door', () => {
    // A field that changes `type` under a manager is already awkward for it; a
    // field that changes the hint as well is how a saved password ends up
    // offered on the form that is trying to set a new one.
    at('/login')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    cleanup()

    at('/signup', 'signup')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
  })

  it('signs in with the password showing', async () => {
    at('/login')
    fill()
    reveal()
    await submit()

    expect(useAuthStore.getState().logIn).toHaveBeenCalledWith('coach@example.com', PASSWORD)
    expect(screen.getByTestId('where')).toHaveTextContent('/board')
  })
})

/**
 * Typing it twice when it is being set for the first time.
 *
 * Both forms that *change* an existing password already confirm it, in these
 * exact words. Neither form that sets one did, and signup is the one where a
 * typo costs most: there is no reset email here, so the only way back into an
 * account whose password went in wrong is the security question the person set
 * ninety seconds earlier, having never once seen the password they are locked
 * out of.
 */
describe('AuthPage confirming a password that is being set', () => {
  const MESSAGE = 'Those two passwords do not match.'

  it('asks for it twice on signup', () => {
    at('/signup', 'signup')
    expect(screen.getByLabelText('Confirm')).toBeInTheDocument()
  })

  it('does not ask twice on sign-in', () => {
    // Nothing is being set, and there is nothing to guard against: a mistyped
    // password on this form is refused in a second and retyped.
    at('/login')
    expect(screen.queryByLabelText('Confirm')).toBeNull()
  })

  it('refuses two that do not match, and says the same thing the other forms say', async () => {
    at('/signup', 'signup')
    fill(PASSWORD, 'Prehnite!7721')
    await submit()

    expect(screen.getByText(MESSAGE)).toBeInTheDocument()
    expect(useAuthStore.getState().signUp).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/signup')
  })

  it('sends one password when they match, and not the copy', async () => {
    // `POST /api/auth/signup` takes one password and should keep taking one: a
    // confirmation is a typo guard in a form, not a fact about an account.
    at('/signup', 'signup')
    fill()
    await submit()

    const call = (useAuthStore.getState().signUp as Mock).mock.calls[0]
    expect(call).toEqual(['coach@example.com', PASSWORD, false, '', '', ''])
  })

  it('lets a corrected mismatch through', async () => {
    // The refusal has to be recoverable in place. Clearing either field, or
    // leaving the error up after it stops being true, would both read as the
    // form having broken.
    at('/signup', 'signup')
    fill(PASSWORD, 'Prehnite!7721')
    await submit()
    expect(screen.getByText(MESSAGE)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: PASSWORD } })
    await submit()

    expect(useAuthStore.getState().signUp).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(MESSAGE)).toBeNull()
  })
})

/**
 * `/signup` is a prerendered page now, and this is the half that keeps it
 * honest.
 *
 * `scripts/prerender.mjs` writes a static copy of this page's words into
 * `dist/signup.html` for the crawlers that never run React. Two renderers, one
 * set of sentences — and if the tree ever stops saying what the static document
 * says, that is not drift, it is cloaking: showing a search engine words the
 * visitor never sees. `src/content/marketing.js` forbids it in its header, and
 * nothing enforced it until this.
 *
 * Asserted against `PAGES` rather than against string literals, so the check is
 * "whatever the prerender writes, the page shows" rather than "these particular
 * words appear twice". Someone editing the copy has one place to edit and this
 * test follows them there.
 */
describe('the sign-up page a crawler reads', () => {
  const page = PAGES.find((p) => p.path === '/signup')!
  // `body` is optional on a `PAGES` entry — `/board` has none, because a canvas
  // has no honest paragraph. Defaulting rather than asserting non-null keeps the
  // types honest, and the emptiness check below is the assertion that matters:
  // a `/signup` entry with no copy would pass every loop in here vacuously.
  const body: string[] = page.body ?? []

  it('has copy at all, which every check below assumes', () => {
    expect(body.length).toBeGreaterThan(0)
  })

  it('shows every sentence the prerendered document claims it does', () => {
    at('/signup', 'signup')

    expect(screen.getByRole('heading', { level: 1, name: page.heading })).toBeInTheDocument()
    for (const line of body) {
      expect(screen.getByText(line), `not on the page: "${line.slice(0, 48)}…"`).toBeInTheDocument()
    }
  })

  it('says none of it on the sign-in page, which has no prerendered copy', () => {
    // `/login` still answers `X-Robots-Tag: noindex` and has no static document,
    // so this copy there would be marketing on a page nobody arrives at from a
    // search, in front of somebody who has already decided.
    at('/login')
    for (const line of body) expect(screen.queryByText(line)).toBeNull()
  })

  it('is in the sitemap, and is therefore not one of the noindex routes', () => {
    // The two follow from the same fact — being in `PAGES` is what gives it a
    // prerendered document, keeps the fallback's `noindex` header off it, and
    // puts it in the generated sitemap. Asserted here so the reason is written
    // down next to the copy rather than only in a server test.
    expect(PAGES.map((p) => p.path)).toContain('/signup')
    expect(page.file).toBe('signup.html')
  })
})
