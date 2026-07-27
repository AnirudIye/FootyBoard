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
  signUp: (email: string, password: string, acceptedTerms: boolean) =>
    request<{ user: ApiUser }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, acceptedTerms }),
    }),

  logIn: (email: string, password: string) =>
    request<{ user: ApiUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logOut: () => request<void>('/auth/logout', { method: 'POST' }),

  requestPasswordReset: (email: string) =>
    request<{ ok: true }>('/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) }),

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

  saveBoard: <T>(id: string, name: string, data: T) =>
    request<{ board: BoardSummary }>(`/boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, data }),
    }),

  deleteBoard: (id: string) => request<void>(`/boards/${id}`, { method: 'DELETE' }),

  /** Creates or rotates the link. The plaintext token comes back only here. */
  createShare: (boardId: string) =>
    request<{ share: ShareMeta & { token: string } }>(`/boards/${boardId}/share`, {
      method: 'POST',
    }),

  getShare: (boardId: string) =>
    request<{ share: ShareMeta | null }>(`/boards/${boardId}/share`),

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
   */
  askAssistant: (body: {
    message: string
    board: string
    formationNames: string[]
    kind: string
    activeTeam: string
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
