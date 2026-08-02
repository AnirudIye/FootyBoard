import { AppError, ConflictError } from './errors'

/**
 * Thin wrapper over the API.
 *
 * `credentials: 'include'` sends the session cookie, which is HttpOnly and so
 * cannot be read or attached by hand. Any error the server explains is
 * re-thrown as an AppError, meaning its message is already safe to show; a
 * network failure or an unexplained status becomes a generic message instead.
 */

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'include',
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    })
  } catch {
    throw new AppError("Can't reach the server. Check your connection and try again.")
  }

  if (response.status === 204) return undefined as T

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : 'That did not work. Try again.'

    // A write refused because the board moved on. Given its own type so the save
    // path can tell it from every other explained failure without reading prose:
    // it is the one 4xx here that is answered by re-reading rather than by
    // showing somebody a message.
    if (response.status === 409) {
      const generation = (payload as { generation?: unknown } | null)?.generation
      throw new ConflictError(message, typeof generation === 'number' ? generation : 0)
    }

    throw new AppError(message)
  }

  return payload as T
}

export interface ApiUser {
  id: string
  /**
   * Null for a guest, which genuinely has none.
   *
   * A guest account is created by redeeming a join code without signing in, so
   * there is no address to store and no password either. Nullable here rather
   * than a separate type, because every other field means the same thing for both
   * kinds and two types would have to be kept in step by hand.
   */
  email: string | null
  /**
   * The name other people in a room are told, or null.
   *
   * Required at signup and when a guest claims their account, so every account
   * made from now on has one. Null means an account that predates the field, and
   * the consequence is real rather than cosmetic: until they set one, the room
   * goes on calling them by their address. That is known gap 2 in the handoff, and
   * the reason `/name` exists.
   *
   * Nullable rather than defaulted to the address here, deliberately. What the
   * room is told is the server's decision, made in one place, and a fallback
   * written on this side too would be a second copy of that rule in the one
   * place it cannot be enforced.
   */
  displayName: string | null
  createdAt: string
  /** Whether this account was handed out by a join code rather than created. */
  isGuest: boolean
  /**
   * Whether signing in to this account needs a code as well as the password.
   *
   * Derived server-side from `totp_confirmed_at` and **never** from the presence
   * of a secret. An account can hold a sealed secret with the factor still off,
   * because that is what an enrollment somebody started and abandoned looks like,
   * and reporting it as on would show a locked-looking account page for a factor
   * no authenticator could satisfy.
   *
   * Read, never written: turning it on is `/2fa`, and this field is what that
   * page and the account menu render from.
   */
  twoFactorEnabled: boolean
}

/**
 * The thing a correct password buys when the account has a second factor.
 *
 * It is not a session and deliberately not a cookie: it comes back in the
 * response body and lives only in the memory of the page asking for the code, so
 * reloading mid sign-in means starting again. `expiresInMinutes` comes from the
 * server rather than being written down here, because the TTL is the server's
 * and a copy on this side is a copy that drifts.
 */
export interface LoginChallenge {
  token: string
  expiresInMinutes: number
}

/**
 * What `POST /api/auth/login` answers, with exactly one of the two null.
 *
 * Both keys always present rather than a union to narrow, which is the shape
 * `getShare` already uses. It also means `const { user } = await api.logIn(...)`
 * goes on reading for every account that has no factor.
 */
export interface LoginResult {
  user: ApiUser | null
  challenge: LoginChallenge | null
}

/**
 * One of the predefined security questions.
 *
 * The list is **not** written down here. It is fetched from
 * `/auth/security-questions`, which is the same array the server validates a
 * submitted id against, so the dropdown and the check behind it cannot disagree
 * about what exists. Copying the questions into the client would be a second
 * source of truth for something that has exactly one.
 */
export interface SecurityQuestion {
  id: string
  label: string
}

export type BoardRole = 'owner' | 'member'

export interface BoardSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  role?: BoardRole
  /** Whether the owner currently allows members to edit. */
  membersCanEdit?: boolean
}

export interface ShareMeta {
  id: string
  /** The short join code. Readable again, unlike the link token. */
  code: string
  /** Epoch ms. Codes are session-scoped; the link does not expire. */
  codeExpiresAt: number
  createdAt: string
}

/**
 * Somebody with access to a board, as the owner is told about them.
 *
 * The same division the room's `Peer` makes, and for the same reason: `email` is
 * what the server chose to disclose and **`displayName` is the only field to
 * render**. They are not interchangeable here either. `email` is null for a guest,
 * which is what used to draw a blank row with a Remove button beside it, while
 * `displayName` always says something: the address when there is one, because the
 * owner is entitled to know who has access to their board, and a chosen or
 * generated name when there is not.
 */
export interface BoardMember {
  id: string
  email: string | null
  displayName: string
  joinedAt: string
}

export const api = {
  /** The question list the signup and recovery dropdowns are built from. */
  securityQuestions: () =>
    request<{ questions: SecurityQuestion[] }>('/auth/security-questions'),

  /**
   * `displayName` is not optional, here or on the server.
   *
   * It is what the room calls this person, and the alternative the relay falls
   * back on is their email address. Asking at signup is what makes a new account
   * safe without anybody having to think about it later.
   */
  signUp: (
    email: string,
    password: string,
    acceptedTerms: boolean,
    securityQuestionId: string,
    securityAnswer: string,
    displayName: string,
  ) =>
    request<{ user: ApiUser }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        acceptedTerms,
        securityQuestionId,
        securityAnswer,
        displayName,
      }),
    }),

  /**
   * A password, and then either a user or a challenge.
   *
   * A 200 either way, which is what lets a challenge reach the page at all:
   * `request` throws for every non-2xx, so a challenge delivered as an error
   * would arrive as a sentence with nothing to spend. `challenge` non-null means
   * no session was minted and the second step is owed.
   */
  logIn: (email: string, password: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /**
   * The second step of signing in: the challenge, and a code from the
   * authenticator app or one of the recovery codes.
   *
   * **The challenge is spent whether the code is right or wrong**, because the
   * server claims the row before comparing, so one challenge buys exactly one
   * guess. A caller that catches the failure must send the person back to the
   * password step rather than offering another go at the same token, which would
   * fail every time however right the code was.
   *
   * The account is named by the challenge row and never by anything in this
   * body, so there is no shape of this call that signs somebody else in.
   */
  completeTwoFactor: (token: string, code: string) =>
    request<{ user: ApiUser }>('/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({ token, code }),
    }),

  /**
   * Give a guest account real credentials, keeping everything it already holds.
   *
   * Deliberately not `signUp`. That would create a second account and leave the
   * guest's boards and memberships behind on the first, which is the whole
   * failure this exists to prevent. The server refuses it for an account that
   * already has a password, because no current password is asked for here.
   */
  claim: (
    email: string,
    password: string,
    acceptedTerms: boolean,
    securityQuestionId: string,
    securityAnswer: string,
    displayName: string,
  ) =>
    request<{ user: ApiUser }>('/auth/claim', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        acceptedTerms,
        securityQuestionId,
        securityAnswer,
        displayName,
      }),
    }),

  /**
   * Set or change the name other people in a room see.
   *
   * PATCH, because it changes one field of an account that already exists, which
   * is what the two owner switches on a board use it for. No current password:
   * this is not a credential, and a guest has none to give while being exactly
   * who benefits most from having a name at all.
   *
   * The room hears it on the next connection rather than immediately, because the
   * relay reads the name when a socket is authorized. Worth knowing before
   * wondering why a rename did not appear on a board that is already open.
   */
  setDisplayName: (displayName: string) =>
    request<{ user: ApiUser }>('/auth/display-name', {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),

  logOut: () => request<void>('/auth/logout', { method: 'POST' }),

  /**
   * Change the password while signed in. The security question goes with it,
   * because that is the only way back in if this new password is forgotten and
   * the old answer may be years stale.
   *
   * Every other session is signed out server-side; this one is replaced, so the
   * browser making the change stays signed in.
   */
  changePassword: (
    currentPassword: string,
    password: string,
    securityQuestionId: string,
    securityAnswer: string,
  ) =>
    request<{ ok: true }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, password, securityQuestionId, securityAnswer }),
    }),

  /**
   * End every session on this account and keep the password.
   *
   * The control for somebody who thinks a session has been taken. Until this
   * existed the only way to end them all was `changePassword`, which made them
   * invent a new password on the way, so the price of throwing an intruder out
   * was a credential change nobody wanted.
   *
   * The current password is what makes it useless to the intruder, so it is the
   * whole body. Every session goes, including this browser's, and the response
   * sets the cookie for the one the server mints to replace it: the session
   * changes, the account does not.
   *
   * No store action stands behind this, deliberately. Nothing in `authStore`
   * changes, because the same person stays signed in, and a passthrough action
   * would be a second name for one call. `changePassword` is called directly for
   * exactly the same reason.
   */
  signOutEverywhere: (currentPassword: string) =>
    request<{ ok: true }>('/auth/sessions', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  /**
   * Whether the factor is on, and how many ways back in are left.
   *
   * `enabled` is already on the user object, so this exists for the count. It is
   * the part that has to be visible: an account with the factor on and no unused
   * recovery codes is one lost phone away from needing an operator, and the
   * `/2fa` page can only say so if it can see it.
   *
   * The codes themselves are never in this answer. They are said once, by
   * `confirmTwoFactorEnrollment` and `regenerateRecoveryCodes`, and a status call
   * that could hand them back would give them to anybody holding a session.
   */
  twoFactorStatus: () =>
    request<{ enabled: boolean; remainingRecoveryCodes: number }>('/auth/2fa'),

  /**
   * Step one of turning it on: a secret to put in an authenticator app.
   *
   * The current password is required, and it is the same door `changePassword`
   * and `signOutEverywhere` go through: a session left open on a shared machine
   * must not be enough to attach somebody else's authenticator, which would be a
   * lockout rather than a nuisance. **A guest is refused by that same door**, with
   * `field: 'currentPassword'` and a message about having no password, which is
   * the signal to send them to `/claim` rather than to show them a password box.
   *
   * Nothing is on yet when this returns. Only `confirmTwoFactorEnrollment`
   * turns it on, so an enrollment abandoned here leaves a secret nothing reads.
   */
  beginTwoFactorEnrollment: (currentPassword: string) =>
    request<{ secret: string; uri: string }>('/auth/2fa/enroll', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  /**
   * Step two: prove the app is generating this account's codes, and turn it on.
   *
   * The ten recovery codes come back here and from `regenerateRecoveryCodes`, and
   * from nowhere else, ever. Whatever this resolves is the only copy the person
   * will be shown, so a caller that drops it has thrown away the account's way
   * back in.
   */
  confirmTwoFactorEnrollment: (code: string) =>
    request<{ recoveryCodes: string[] }>('/auth/2fa/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  /**
   * Turn the factor off. Both the password and a live code, because a disable
   * behind the password alone would make the whole feature exactly as strong as
   * the password. A recovery code works in place of the app's code.
   *
   * Sessions are deliberately left alone: nothing about their authority changed,
   * and the person has just proved both factors on this request.
   */
  disableTwoFactor: (currentPassword: string, code: string) =>
    request<{ ok: true }>('/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, code }),
    }),

  /**
   * Replace all ten recovery codes, invalidating the previous ten in the same
   * statement. Same body as the disable and for the same reason: a fresh set of
   * ten codes is a set of ten new ways into the account.
   */
  regenerateRecoveryCodes: (currentPassword: string, code: string) =>
    request<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, code }),
    }),

  /**
   * Step one of recovery: which question guards this address.
   *
   * Every address gets one back, including addresses with no account, so this
   * cannot be used to find out who is registered. An answer to a question that
   * was never anybody's simply fails at the next step.
   */
  startPasswordRecovery: (email: string) =>
    request<{ question: SecurityQuestion }>('/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  /**
   * Step two: the answer, in exchange for a short-lived single-use token, or for
   * a challenge when the account has a second factor.
   *
   * Exactly one of `token` and `challenge` is non-null, the same shape `logIn`
   * uses. `expiresInMinutes` describes the **reset token** and is on the response
   * either way, so the copy on the page does not have to guard a field that
   * appears and disappears; the challenge carries its own, shorter one.
   *
   * The factor is demanded here rather than in front of `resetPassword`, because
   * the reset token is the credential: issuing one and then guarding its use
   * would put the code in front of something already handed out.
   */
  verifySecurityAnswer: (email: string, answer: string) =>
    request<{ token: string | null; challenge: LoginChallenge | null; expiresInMinutes: number }>(
      '/auth/forgot/verify',
      { method: 'POST', body: JSON.stringify({ email, answer }) },
    ),

  /**
   * Step two and a half: the code, in exchange for the reset token.
   *
   * The same one-guess-per-challenge rule `completeTwoFactor` carries, and the
   * same consequence for a caller: a refusal here means starting the recovery
   * again from the address, not another attempt on this token.
   */
  completeRecoveryTwoFactor: (token: string, code: string) =>
    request<{ token: string; expiresInMinutes: number }>('/auth/forgot/2fa', {
      method: 'POST',
      body: JSON.stringify({ token, code }),
    }),

  /** Step three. The token works once and signs every session out. */
  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>('/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  me: () => request<{ user: ApiUser }>('/auth/me'),

  /**
   * Delete the account and, by cascade, every board saved under it.
   *
   * **The current password is required, and a code as well when the factor is
   * on**, which is the same door `changePassword` and `signOutEverywhere` go
   * through and for the same reason: a session left open on a shared machine
   * must not be enough to do the one thing nothing can undo. Until 2026-07-30
   * this call carried no body at all.
   *
   * Both are optional *here* rather than required, because a **guest** account
   * has no password to send and the server lets one through on the session
   * alone. That is not a hole: `verifyPassword` answers false for a guest's null
   * salt by design, so demanding a password would make deletion impossible for
   * that account rather than merely harder, and the privacy policy promises
   * deletion to everybody. The server decides which rule applies from the row,
   * never from what this sends.
   */
  deleteAccount: (currentPassword?: string, code?: string) =>
    request<void>('/auth/me', {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword, code }),
    }),

  listBoards: (limit = 20, cursor?: string) =>
    request<{ boards: BoardSummary[]; nextCursor: string | null }>(
      `/boards?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  /**
   * The board's contents, and the state of it they are. `generation` is the base
   * every later write to this board has to carry, so it is read here rather than
   * from an endpoint of its own: "these contents" and "which lineage they are on"
   * are one fact and fetching them separately would let them disagree.
   */
  getBoard: <T>(id: string) =>
    request<{ board: BoardSummary & { data: T; generation: number } }>(`/boards/${id}`),

  createBoard: <T>(name: string, data: T) =>
    request<{ board: BoardSummary }>('/boards', {
      method: 'POST',
      body: JSON.stringify({ name, data }),
    }),

  renameBoard: (id: string, name: string) =>
    request<{ board: BoardSummary }>(`/boards/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /**
   * Write the board's contents. `name` is omitted when the caller does not
   * know it, and the server then leaves the stored title alone: sending a
   * guess is how a board could get renamed by a client that had simply never
   * loaded its name.
   *
   * `baseGeneration` is the state of the board these contents were derived from,
   * and the server refuses the write if the board has been replaced since. That
   * is what stops a debounced autosave carrying pre-undo contents from landing
   * after the undo and winning. `replacing` marks this write as a whole-board
   * replacement, which is what moves the generation on; it must be true exactly
   * when the caller will also broadcast `replaced`.
   */
  saveBoard: <T>(
    id: string,
    name: string | null,
    data: T,
    baseGeneration: number,
    replacing: boolean,
  ) =>
    request<{ board: BoardSummary & { generation: number } }>(`/boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(name === null ? {} : { name }),
        data,
        baseGeneration,
        replacing,
      }),
    }),

  deleteBoard: (id: string) => request<void>(`/boards/${id}`, { method: 'DELETE' }),

  /** Creates or rotates the link. The plaintext token comes back only here. */
  createShare: (boardId: string) =>
    request<{ share: ShareMeta & { token: string } }>(`/boards/${boardId}/share`, {
      method: 'POST',
    }),

  /**
   * Whether a link is live, what the join code is, and how guests are named.
   *
   * The token is never in this answer: it is stored hashed and exists in the
   * clear only in the reply to `createShare`. `anonymousPresence` sits beside
   * `share` rather than inside it because it belongs to the board and outlives
   * any particular link, so turning sharing off does not read as turning
   * anonymity off.
   */
  getShare: (boardId: string) =>
    request<{ share: ShareMeta | null; anonymousPresence: boolean }>(
      `/boards/${boardId}/share`,
    ),

  /** A fresh code on the existing share. Leaves the link, and members, alone. */
  refreshCode: (boardId: string) =>
    request<{ share: Pick<ShareMeta, 'id' | 'code' | 'codeExpiresAt'> }>(
      `/boards/${boardId}/share/code`,
      { method: 'POST' },
    ),

  revokeShare: (boardId: string) =>
    request<void>(`/boards/${boardId}/share`, { method: 'DELETE' }),

  listMembers: (boardId: string) =>
    request<{ members: BoardMember[] }>(`/boards/${boardId}/members`),

  removeMember: (boardId: string, userId: string) =>
    request<void>(`/boards/${boardId}/members/${userId}`, { method: 'DELETE' }),

  setBoardLock: (boardId: string, locked: boolean) =>
    request<{ locked: boolean }>(`/boards/${boardId}/lock`, {
      method: 'PATCH',
      body: JSON.stringify({ locked }),
    }),

  /**
   * Whether guests are named by a generated animal instead of their address.
   *
   * A sibling of the lock rather than a field on it, because the two have
   * different blast radii and a shared route would let either one silently
   * carry the other's change. The answer echoes what the board now says, which
   * is what the switch should show.
   *
   * Note the path. `sharesRouter` is mounted at `/api/boards`; only redeeming
   * lives under `/api/shares`, and probing that prefix answers "No such
   * endpoint", which reads exactly like a route that was never added.
   */
  setAnonymousPresence: (boardId: string, anonymous: boolean) =>
    request<{ anonymousPresence: boolean }>(`/boards/${boardId}/anonymous`, {
      method: 'PATCH',
      body: JSON.stringify({ anonymous }),
    }),

  redeemShare: (token: string) =>
    request<{ board: { id: string; name: string } }>(
      `/shares/${encodeURIComponent(token)}/redeem`,
      { method: 'POST' },
    ),

  /**
   * The same redemption, for somebody who has no account yet.
   *
   * Separate from `redeemShare` rather than an argument to it, exactly as
   * `joinAsGuest` is separate from joining: the server takes `asGuest` as an
   * explicit statement of intent and never infers it from a missing cookie,
   * because a missing cookie is also what an expired session looks like. Two
   * named methods make the caller say which one it means, and there is only one
   * caller of this — the guest door on the auth page.
   */
  redeemShareAsGuest: (token: string) =>
    request<{ board: { id: string; name: string } }>(
      `/shares/${encodeURIComponent(token)}/redeem`,
      { method: 'POST', body: JSON.stringify({ asGuest: true }) },
    ),

  /** Whether the AI fallback is configured on the server. */
  assistantStatus: () => request<{ enabled: boolean }>('/assistant/status'),

  /**
   * Ask the AI fallback. Only called when the offline parser did not recognise
   * the message — see `runAssistant`.
   *
   * `consent` is required by the server, which rejects the request outright
   * without it and records the grant against the account on the first one it
   * accepts. Enforcing opt-in in the browser alone is not a consent basis: it
   * is a checkbox anybody can skip past by calling the endpoint directly, and
   * it leaves no record that anyone ever agreed to their messages and their
   * board being sent to an outside provider. Send `true` only when the person
   * has actually opted in from the panel.
   */
  askAssistant: (body: {
    message: string
    board: string
    formationNames: string[]
    kind: string
    activeTeam: string
    consent: boolean
  }) =>
    request<{ reply: string | null; command: { type: string } & Record<string, unknown> | null }>(
      '/assistant',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Join by typing the short code rather than following a link. */
  joinWithCode: (code: string) =>
    request<{ board: { id: string; name: string } }>('/shares/join', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  /**
   * Redeem a code with no account, taking one in the process.
   *
   * `asGuest` is sent explicitly and the server requires it, rather than the
   * absence of a session being taken as consent. A missing cookie is also what an
   * expired session looks like, and turning that person into a brand new guest
   * would walk them away from their own boards without a word. Only the guest
   * door on the auth page calls this.
   */
  joinAsGuest: (code: string) =>
    request<{ board: { id: string; name: string } }>('/shares/join', {
      method: 'POST',
      body: JSON.stringify({ code, asGuest: true }),
    }),
}
