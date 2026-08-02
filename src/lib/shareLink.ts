/**
 * The share token, and how it travels.
 *
 * A share link is `/board?board=<id>&share=<token>`. Somebody who is not signed
 * in never reaches the board with it: `useShareLink` sends them to
 * `/login?next=<that whole path>` first, so the auth page is holding the token
 * and has to be able to find it again.
 *
 * This is `codeInNext`'s counterpart and is deliberately shaped like it. The two
 * answer the same question about the same `next` and are asked one line apart,
 * so they should be read together and should not disagree about what a `next`
 * carrying neither looks like — both say `null`.
 *
 * A token is not validated here beyond being non-empty. Unlike a join code there
 * is no alphabet or length to check against: it is 32 random bytes as base64url,
 * and the only thing that can say whether it is real is the server. Guessing at
 * a shape here would mean this file deciding a live link is malformed on the day
 * the token format changes.
 */
export const shareTokenInNext = (next: string | null): string | null => {
  if (!next) return null
  const mark = next.indexOf('?')
  if (mark === -1 || next.slice(0, mark) !== '/board') return null
  const token = new URLSearchParams(next.slice(mark + 1)).get('share')
  return token ? token : null
}
