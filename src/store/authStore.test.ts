import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { api } from '../lib/api'
import { useAuthStore } from './authStore'

/**
 * What the store does with a sign-in that is not finished yet.
 *
 * `POST /api/auth/login` answers 200 with `{ user, challenge }` and exactly one
 * of them null, so a correct password on an account with a second factor buys a
 * challenge and no session at all. The store used to swallow the whole response
 * and set `user` from it, which against the new shape would put `null` in the
 * store and tell the page nothing about why.
 *
 * So the two halves are asserted separately: `logIn` hands the challenge back
 * and leaves the store empty, and `completeTwoFactor` is the call that puts a
 * user in it. The page cannot navigate off the first one, which is the whole
 * behaviour the sign-in form is built on.
 */

vi.mock('../lib/api', () => ({
  api: { logIn: vi.fn(), completeTwoFactor: vi.fn() },
}))

const mockApi = api as unknown as { logIn: Mock; completeTwoFactor: Mock }

const USER = {
  id: 'u1',
  email: 'coach@example.com',
  displayName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  isGuest: false,
  twoFactorEnabled: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ user: null, ready: false })
})

afterEach(() => {
  useAuthStore.setState({ user: null, ready: false })
})

describe('signing in behind a second factor', () => {
  it('hands the challenge back rather than swallowing it', async () => {
    mockApi.logIn.mockResolvedValue({
      user: null,
      challenge: { token: 'challenge-token', expiresInMinutes: 5 },
    })

    const challenge = await useAuthStore.getState().logIn('coach@example.com', 'a-real-password')

    expect(challenge).toEqual({ token: 'challenge-token', expiresInMinutes: 5 })
    // Nobody is signed in yet, and the store saying otherwise is the failure this
    // exists to stop: the server has minted no session either.
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('puts the user in the store only once the code is accepted', async () => {
    mockApi.completeTwoFactor.mockResolvedValue({ user: USER })

    await useAuthStore.getState().completeTwoFactor('challenge-token', '123456')

    expect(mockApi.completeTwoFactor).toHaveBeenCalledWith('challenge-token', '123456')
    expect(useAuthStore.getState().user).toEqual(USER)
    expect(useAuthStore.getState().ready).toBe(true)
  })
})

describe('signing in with no second factor', () => {
  it('signs straight in and reports no challenge', async () => {
    mockApi.logIn.mockResolvedValue({ user: { ...USER, twoFactorEnabled: false }, challenge: null })

    const challenge = await useAuthStore.getState().logIn('coach@example.com', 'a-real-password')

    expect(challenge).toBeNull()
    expect(useAuthStore.getState().user?.id).toBe('u1')
    expect(useAuthStore.getState().ready).toBe(true)
  })
})
