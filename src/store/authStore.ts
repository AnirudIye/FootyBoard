import { create } from 'zustand'
import { api } from '../lib/api'
import type { ApiUser, LoginChallenge } from '../lib/api'

interface AuthState {
  /**
   * The account behind this browser, or null when there is none.
   *
   * **One fact, rather than the three that used to be derived from it.** This was
   * `email: string | null`, which worked for exactly as long as every account had
   * an address: it doubled as the signed-in flag, and five of its twelve readers
   * called it `signedIn` rather than `email`, which was the design telling on
   * itself. A guest admitted by a join code has an account and no address, so
   * "is anybody signed in" and "what is their address" came apart and the flag
   * could not go on being the address.
   *
   * Both questions are answered by the selectors below rather than by fields
   * stored beside this one, because three copies of one fact is how two of them
   * end up disagreeing.
   */
  user: ApiUser | null
  /** True once the server has been asked who we are, so the UI can wait. */
  ready: boolean
  restore: () => Promise<void>
  signUp: (
    email: string,
    password: string,
    acceptedTerms: boolean,
    securityQuestionId: string,
    securityAnswer: string,
    displayName: string,
  ) => Promise<void>
  /**
   * A correct password, and then either a signed-in account or the second step.
   *
   * **It returns the challenge rather than swallowing the result**, which is the
   * one thing this action has to do differently from `signUp` and `claim`. A
   * correct password on an account with a factor mints no session at all, so
   * setting `user` from that response would put null in the store and leave the
   * page with nothing to say. Null back means signed in and the caller may go on.
   */
  logIn: (email: string, password: string) => Promise<LoginChallenge | null>
  /**
   * The second step, and the call that actually puts a user in the store.
   *
   * A store action rather than a bare `api` call, unlike the enrollment ones,
   * and the test is the one `setDisplayName`'s comment states: does anything here
   * change. This is a sign-in, so it changes everything; turning the factor on or
   * off changes one boolean the page refetches anyway.
   */
  completeTwoFactor: (token: string, code: string) => Promise<void>
  /**
   * Attach real credentials to the guest account this browser is already using.
   *
   * Not a sign-up: it sets them on the account that already holds the boards.
   * Signing up instead would make a second account and leave the work on the
   * first, which is the trap guest admission would otherwise create.
   */
  claim: (
    email: string,
    password: string,
    acceptedTerms: boolean,
    securityQuestionId: string,
    securityAnswer: string,
    displayName: string,
  ) => Promise<void>
  /**
   * Change the name a room calls you.
   *
   * A store action rather than a bare `api` call, unlike `changePassword`, and the
   * difference is whether anything here changes: a password change leaves the same
   * person signed in with the same fields, while this one is a field on the user
   * object the whole app reads. Without it the popover would keep showing the old
   * name until something else happened to refetch the account.
   */
  setDisplayName: (displayName: string) => Promise<void>
  logOut: () => Promise<void>
  /**
   * Delete the account and every board under it.
   *
   * Takes the current password, and a code when the factor is on. Both are
   * optional because a guest has neither and the server admits one on the
   * session alone; what may be omitted is decided by the account, not by the
   * caller.
   */
  deleteAccount: (currentPassword?: string, code?: string) => Promise<void>
}

/**
 * Whether there is an account behind this browser at all, guest or not.
 *
 * The gate for everything that needs a server: loading boards, saving them,
 * joining a room. A guest passes it, because a guest has a real account and real
 * membership; what a guest lacks is an address, which is a different question and
 * has its own selector.
 */
export const selectSignedIn = (s: AuthState) => s.user !== null

/** The address, or null for a guest, which genuinely has none. */
export const selectEmail = (s: AuthState) => s.user?.email ?? null

/** Whether this account was handed out by a join code rather than created. */
export const selectIsGuest = (s: AuthState) => s.user?.isGuest === true

/**
 * Whether signing in to this account takes a code as well as the password.
 *
 * `=== true` rather than a coercion, matching `selectIsGuest`: nobody signed in
 * is not a factor that is off, and the two are only the same answer by accident.
 * The server decides this from `totp_confirmed_at`; nothing on this side may.
 */
export const selectTwoFactorEnabled = (s: AuthState) => s.user?.twoFactorEnabled === true

/**
 * The name a room calls this person, or null if they have never chosen one.
 *
 * Null is a real state rather than a loading one: an account made before display
 * names existed has none, and until it does the room names it by its address. The
 * one place that matters to the interface is whether to invite somebody to pick a
 * name, so the null is left visible rather than papered over with the address.
 */
export const selectDisplayName = (s: AuthState) => s.user?.displayName ?? null

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ready: false,

  /**
   * The session lives in an HttpOnly cookie, so the only way to know whether
   * we are signed in is to ask. A 401 here is the normal signed-out case, not a
   * failure worth surfacing.
   */
  restore: async () => {
    try {
      const { user } = await api.me()
      set({ user, ready: true })
    } catch {
      set({ user: null, ready: true })
    }
  },

  signUp: async (
    email,
    password,
    acceptedTerms,
    securityQuestionId,
    securityAnswer,
    displayName,
  ) => {
    const { user } = await api.signUp(
      email,
      password,
      acceptedTerms,
      securityQuestionId,
      securityAnswer,
      displayName,
    )
    set({ user, ready: true })
  },

  logIn: async (email, password) => {
    const { user, challenge } = await api.logIn(email, password)
    // Only when there is one. Writing `user` unconditionally would store the
    // null that comes back with a challenge, and `ready: true` beside it would
    // make a half-finished sign-in indistinguishable from a checked signed-out
    // session for every selector in the app.
    if (user) set({ user, ready: true })
    return challenge
  },

  completeTwoFactor: async (token, code) => {
    const { user } = await api.completeTwoFactor(token, code)
    set({ user, ready: true })
  },

  claim: async (
    email,
    password,
    acceptedTerms,
    securityQuestionId,
    securityAnswer,
    displayName,
  ) => {
    const { user } = await api.claim(
      email,
      password,
      acceptedTerms,
      securityQuestionId,
      securityAnswer,
      displayName,
    )
    set({ user, ready: true })
  },

  setDisplayName: async (displayName) => {
    const { user } = await api.setDisplayName(displayName)
    set({ user, ready: true })
  },

  logOut: async () => {
    await api.logOut()
    set({ user: null })
  },

  deleteAccount: async (currentPassword, code) => {
    // `user` is cleared only after the request resolves. A refused deletion has
    // changed nothing on the server, and signing the page out of an account that
    // still exists would read as "it worked" for the one action that cannot be
    // checked by looking.
    await api.deleteAccount(currentPassword, code)
    set({ user: null })
  },
}))
