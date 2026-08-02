import { describe, it, expect } from 'vitest'
import { shareTokenInNext } from './shareLink'
import { codeInNext } from './joinCode'

/**
 * What the auth page is holding when somebody arrives from a share link.
 *
 * `AuthPage` asks `codeInNext` and then this, one line apart, and branches on
 * which answered. So the cases that matter are not only "does it find a token"
 * but "do these two ever both claim the same `next`" — if they did, the guest
 * door would redeem the wrong credential.
 */
describe('the share token a post-auth next is carrying', () => {
  const token = 'zX8kq2Lm4nP7rT1vW9yB3dF6hJ0sA5cE'

  it('finds the token in a real share link', () => {
    expect(shareTokenInNext(`/board?board=abc123&share=${token}`)).toBe(token)
  })

  it('finds it whichever order the parameters come in', () => {
    expect(shareTokenInNext(`/board?share=${token}&board=abc123`)).toBe(token)
  })

  it('finds it when the link carries no board id', () => {
    expect(shareTokenInNext(`/board?share=${token}`)).toBe(token)
  })

  it('decodes a token that was percent-encoded on the way in', () => {
    // `next` is built with encodeURIComponent, so a token containing anything
    // URL-significant arrives escaped. URLSearchParams unescapes it, and the
    // value handed to the server has to be the original or redemption fails
    // with a 404 that looks like a revoked link.
    const awkward = 'a+b/c=d'
    const next = `/board?board=abc123&share=${encodeURIComponent(awkward)}`
    expect(shareTokenInNext(next)).toBe(awkward)
  })

  it('says nothing for a null next', () => {
    expect(shareTokenInNext(null)).toBeNull()
  })

  it('says nothing for a board link with no share parameter', () => {
    expect(shareTokenInNext('/board?board=abc123')).toBeNull()
  })

  it('says nothing for a bare board path', () => {
    expect(shareTokenInNext('/board')).toBeNull()
  })

  it('says nothing for an empty share parameter', () => {
    expect(shareTokenInNext('/board?board=abc123&share=')).toBeNull()
  })

  it('refuses a share parameter on some other path', () => {
    // The guest door redeems whatever this returns. A `?share=` hung off an
    // unrelated path is not a share link, and treating it as one would make any
    // page able to drive a redemption.
    expect(shareTokenInNext(`/settings?share=${token}`)).toBeNull()
    expect(shareTokenInNext(`/join?share=${token}`)).toBeNull()
  })

  it('is not fooled by a path that merely starts with /board', () => {
    expect(shareTokenInNext(`/boardroom?share=${token}`)).toBeNull()
  })

  it('never agrees with codeInNext about the same next', () => {
    const shareNext = `/board?board=abc123&share=${token}`
    const codeNext = '/join?code=ABCDEF'

    expect(shareTokenInNext(shareNext)).toBe(token)
    expect(codeInNext(shareNext)).toBeNull()

    expect(codeInNext(codeNext)).toBe('ABCDEF')
    expect(shareTokenInNext(codeNext)).toBeNull()
  })
})
