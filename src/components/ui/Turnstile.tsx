import { useEffect, useRef, useState } from 'react'
import { loadTurnstile, turnstileSitekey, type TurnstileApi } from '../../lib/turnstile'

/**
 * The Turnstile widget, or nothing at all.
 *
 * **Nothing at all is the normal case and has to stay cheap.** Unless the API
 * reports a sitekey, this renders no element, injects no script and makes no
 * further request — a deployment without keys, and every test, sees a form that
 * behaves exactly as it did before this component existed.
 *
 * **The token is handed up rather than read down.** Turnstile writes into a
 * hidden input it creates, which is how a native form post would carry it; every
 * form here submits with `fetch`, so the parent takes the value from
 * `onToken` and puts it in the body itself. `onToken(null)` on expiry or error
 * is as important as the token: a caller that only ever hears about success
 * will submit a stale one, and Cloudflare refuses a token twice.
 */
export function Turnstile({
  onToken,
  action,
  className,
}: {
  onToken: (token: string | null) => void
  /** Shows up in Turnstile analytics, so the three forms can be told apart. */
  action?: string
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const [sitekey, setSitekey] = useState<string | null>(null)
  const [api, setApi] = useState<TurnstileApi | null>(null)

  // Kept in a ref so the render effect below does not re-run — and tear the
  // widget down and back up — every time the parent re-renders with a new
  // closure, which is every keystroke on these forms.
  const report = useRef(onToken)
  report.current = onToken

  useEffect(() => {
    let live = true
    turnstileSitekey().then((key) => {
      if (!live || !key) return
      setSitekey(key)
      loadTurnstile().then((loaded) => {
        if (live) setApi(loaded)
      })
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!api || !sitekey || !box.current) return

    // StrictMode mounts effects twice in development. Rendering a second
    // widget into the same element leaves an orphan that never resolves, so
    // the id is the guard as well as the handle.
    if (widget.current) return

    widget.current = api.render(box.current, {
      sitekey,
      action,
      callback: (token: string) => report.current(token),
      // A token lasts five minutes and Cloudflare refuses a repeat, so an
      // expiry has to reach the form: the alternative is a submit carrying
      // something the server will reject with no way for the person to tell.
      'expired-callback': () => report.current(null),
      'error-callback': () => report.current(null),
    })

    return () => {
      const id = widget.current
      widget.current = null
      if (id) api.remove(id)
    }
  }, [api, sitekey, action])

  if (!sitekey) return null
  return <div ref={box} className={className} />
}
