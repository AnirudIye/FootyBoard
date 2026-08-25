/**
 * Loading Turnstile, once, and only if the server says it is switched on.
 *
 * **Both answers are cached at module scope on purpose.** Three forms use the
 * widget — signup, contact and join — and a person can reach all three in one
 * session. Asking the API which sitekey to use on every mount, and injecting
 * the script tag more than once, are both avoidable; the promises below are
 * what avoids them.
 *
 * The sitekey comes from the server rather than from a build-time `VITE_` value
 * so that one setting on the API turns the feature on and off. `server/src/
 * turnstile.js` argues that at length; the short version is that a sitekey and
 * a secret configured in different places can disagree, and both ways of
 * disagreeing are worse than the feature being off.
 */

/** The field name Turnstile's own hidden input uses, and so the one we send. */
export const TOKEN_FIELD = 'cf-turnstile-response'

/**
 * The host, not the path.
 *
 * `/turnstile/v0/api.js` 302s to a build-hashed path that rotates, which is
 * also why `src/lib/csp.js` allowlists the origin rather than the file.
 */
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

export type TurnstileOptions = {
  sitekey: string
  callback: (token: string) => void
  'error-callback'?: (code: string) => void
  'expired-callback'?: () => void
  theme?: 'auto' | 'light' | 'dark'
  size?: 'normal' | 'flexible' | 'compact'
  action?: string
}

export type TurnstileApi = {
  render: (el: HTMLElement, options: TurnstileOptions) => string
  reset: (id?: string) => void
  remove: (id?: string) => void
  getResponse: (id?: string) => string | undefined
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let sitekeyPromise: Promise<string | null> | null = null

/**
 * Whether the server wants a widget, and which one.
 *
 * `null` means the feature is off, which is the state a deployment with no
 * keys is in and the state every test is in. A failed request is treated the
 * same way: the form still works, it simply does not carry a token, and the
 * server is not asking for one in that configuration either.
 */
export function turnstileSitekey(): Promise<string | null> {
  sitekeyPromise ??= fetch('/api/turnstile')
    .then((r) => (r.ok ? r.json() : { siteKey: null }))
    .then((body: { siteKey?: string | null }) => body?.siteKey ?? null)
    .catch(() => null)
  return sitekeyPromise
}

let scriptPromise: Promise<TurnstileApi | null> | null = null

/** Inject `api.js` once and resolve when `window.turnstile` exists. */
export function loadTurnstile(): Promise<TurnstileApi | null> {
  scriptPromise ??= new Promise<TurnstileApi | null>((resolve) => {
    if (window.turnstile) return resolve(window.turnstile)

    const el = document.createElement('script')
    el.src = SCRIPT
    el.async = true
    el.defer = true
    el.onload = () => resolve(window.turnstile ?? null)
    // A blocked or failed script is not a broken form. The submission goes
    // without a token, and the server refuses it only in the configuration
    // where it asked for one — which is the configuration where a person can
    // retry and get a widget that loaded.
    el.onerror = () => resolve(null)
    document.head.appendChild(el)
  })
  return scriptPromise
}

/** Test seam: forget both caches so a suite can re-stub them. */
export function resetTurnstileForTests(): void {
  sitekeyPromise = null
  scriptPromise = null
}
