/**
 * Turnstile: proof that a form was filled in by a browser with a person at it.
 *
 * **This is a second layer, not the layer.** `rateLimit.js` already bounds
 * every endpoint guarded here, per address and per network, and it holds
 * across instances because it counts in Postgres. What it cannot do is tell one
 * caller apart from a thousand cheap ones, which is the shape signup and the
 * contact form actually get attacked in. Turnstile answers that question and
 * nothing else; if it is ever removed, the allowances underneath are still
 * doing their job.
 *
 * **Unset, it does nothing at all**, which is the same bargain
 * `contactForward.js` takes with Resend: a deployment without keys behaves
 * exactly as it did before this file existed, so it can ship ahead of the
 * widget being created in the dashboard. `enabled()` is the one place that
 * decides, and it reads the *secret*, never the sitekey — the sitekey is
 * public, travels to the browser, and is not evidence of anything.
 *
 * **It sends over HTTPS with one `fetch` and adds no dependency**, for the
 * reason `assistant.js` and `contactForward.js` both give: three runtime
 * dependencies is the budget, and a verification call is one POST.
 */

/** Where a token is redeemed. */
const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** The name Turnstile's own hidden input uses, and so the name the client sends. */
export const TOKEN_FIELD = 'cf-turnstile-response'

/**
 * How long to wait on Cloudflare before giving up.
 *
 * Short, because somebody is watching a form. `contactForward.js` can afford
 * thirty seconds precisely because nobody is waiting on it; this is the
 * opposite case and sits in front of the response.
 */
const TIMEOUT_MS = 10_000

const secret = () => process.env.TURNSTILE_SECRET_KEY?.trim()

/** The public half, handed to the browser so it knows which widget to render. */
export const siteKey = () => process.env.TURNSTILE_SITE_KEY?.trim() || null

/**
 * Whether verification is switched on.
 *
 * The secret alone decides. A sitekey without a secret would render a widget
 * whose answer nobody checks, which is worse than no widget: it looks like a
 * control and is decoration.
 */
export const enabled = () => Boolean(secret())

/** Raised when a token is missing, refused, or cannot be checked. */
export class TurnstileFailed extends Error {
  constructor(message, codes = []) {
    super(message)
    this.name = 'TurnstileFailed'
    this.status = 400
    this.field = TOKEN_FIELD
    this.codes = codes
  }
}

/**
 * Check a token, or do nothing if Turnstile is not configured.
 *
 * **Fails closed, and the reason is that the alternative is not a smaller
 * failure but a different one.** If Cloudflare cannot be reached, this refuses
 * the request. That means an outage at Cloudflare stops signups — which is
 * real, and is the cost being chosen deliberately, because failing open turns
 * "make the origin's egress time out" into the bypass, and an attacker who can
 * do that gets the whole endpoint back. The rate limiters keep counting
 * either way, so the floor never disappears.
 *
 * **`remoteip` is deliberately not sent.** It is optional, and the address this
 * process has closest to hand is `req.clientIp`, which `limiterIp` has already
 * masked to a /64 for counting — a prefix, not an address, and not a thing
 * Turnstile can be asked about. Sending it would be quietly wrong; recovering
 * the real one only to hand it to a third party is not worth the round trip.
 */
export async function assertHuman(token) {
  if (!enabled()) return

  if (typeof token !== 'string' || !token)
    throw new TurnstileFailed('Complete the verification and try again.', ['missing-input-response'])

  let body
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret(), response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      // Status only. A provider body can quote the request back, and this line
      // goes to a log that is not encrypted.
      console.error(`turnstile siteverify failed: ${response.status}`)
      throw new TurnstileFailed('Could not check the verification. Try again shortly.', [
        'siteverify-unavailable',
      ])
    }
    body = await response.json()
  } catch (err) {
    if (err instanceof TurnstileFailed) throw err
    console.error(`turnstile siteverify failed: ${err.name}`)
    throw new TurnstileFailed('Could not check the verification. Try again shortly.', [
      'siteverify-unreachable',
    ])
  }

  if (body?.success === true) return

  // Hyphen, not underscore: the field really is `error-codes`.
  const codes = Array.isArray(body?.['error-codes']) ? body['error-codes'] : []

  // A spent or expired token is the one failure a person can fix by trying
  // again, and the only one worth naming differently. Everything else is the
  // same sentence, because telling a stranger which way their forgery was
  // wrong is the enumeration problem in another costume.
  const stale = codes.includes('timeout-or-duplicate')
  throw new TurnstileFailed(
    stale
      ? 'That verification has expired. Try again.'
      : 'Verification failed. Try again.',
    codes,
  )
}
