import { AppError } from './errors'

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
    throw new AppError(message)
  }

  return payload as T
}

export interface ApiUser {
  id: string
  email: string
  createdAt: string
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

export interface BoardMember {
  id: string
  email: string
  joinedAt: string
}

export const api = {
  /** The question list the signup and recovery dropdowns are built from. */
  securityQuestions: () =>
    request<{ questions: SecurityQuestion[] }>('/auth/security-questions'),

  signUp: (
    email: string,
    password: string,
    acceptedTerms: boolean,
    securityQuestionId: string,
    securityAnswer: string,
  ) =>
    request<{ user: ApiUser }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        acceptedTerms,
        securityQuestionId,
        securityAnswer,
      }),
    }),

  logIn: (email: string, password: string) =>
    request<{ user: ApiUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
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

  /** Step two: the answer, in exchange for a short-lived single-use token. */
  verifySecurityAnswer: (email: string, answer: string) =>
    request<{ token: string; expiresInMinutes: number }>('/auth/forgot/verify', {
      method: 'POST',
      body: JSON.stringify({ email, answer }),
    }),

  /** Step three. The token works once and signs every session out. */
  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>('/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  me: () => request<{ user: ApiUser }>('/auth/me'),

  deleteAccount: () => request<void>('/auth/me', { method: 'DELETE' }),

  listBoards: (limit = 20, cursor?: string) =>
    request<{ boards: BoardSummary[]; nextCursor: string | null }>(
      `/boards?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  getBoard: <T>(id: string) =>
    request<{ board: BoardSummary & { data: T } }>(`/boards/${id}`),

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
   */
  saveBoard: <T>(id: string, name: string | null, data: T) =>
    request<{ board: BoardSummary }>(`/boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(name === null ? { data } : { name, data }),
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
}
