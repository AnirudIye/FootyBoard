/**
 * The six-letter join code, and how it travels.
 *
 * Three places need the same two facts and none of them may disagree: the join
 * page, which reads what somebody typed; the auth pages, which have to hand a
 * pending code on rather than drop it; and the board's account menu, which
 * hands it back. Two spellings of the alphabet would mean a code the join page
 * accepts being quietly refused one file away.
 */

export const CODE_LENGTH = 6

/** Matches the server's alphabet. No I or O, no digits. */
export const cleanCode = (raw: string) =>
  raw
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z]/g, '')
    .slice(0, CODE_LENGTH)

/** Where a code goes to be redeemed. */
export const joinPath = (code: string) => `/join?code=${code}`

/**
 * The code a post-auth `next` is carrying, if it is carrying one.
 *
 * Only a whole, well-formed code counts. A partial one is nothing we could
 * offer to finish later, so it reads as no code at all rather than as half of
 * one, and nothing downstream has to ask whether what it holds is usable.
 */
export const codeInNext = (next: string | null): string | null => {
  if (!next) return null
  const mark = next.indexOf('?')
  if (mark === -1 || next.slice(0, mark) !== '/join') return null
  const code = cleanCode(new URLSearchParams(next.slice(mark + 1)).get('code') ?? '')
  return code.length === CODE_LENGTH ? code : null
}
