import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { motion } from 'framer-motion'
import FloodlitBackdrop from './landing/FloodlitBackdrop'
import { buttonClass } from './ui/Button'
import { EASE_OUT } from '../theme/motion'
import { toUserMessage } from '../lib/errors'

/**
 * The page at the end of a link that goes nowhere.
 *
 * Without one of these, React Router answers an unmatched path from its own
 * built-in boundary, which is a developer's screen: "Unexpected Application
 * Error", a note about providing an errorElement, and no way back. It ships in
 * the production bundle exactly as it appears in development, so a mistyped
 * address, a stale bookmark or a dead share link put that in front of a coach.
 *
 * This is the same product on the same ground: the floodlit backdrop, the glass
 * surface, the accent micro-label, and two doors out.
 */
function DeadEnd({ label, title, lead }: { label: string; title: string; lead: string }) {
  return (
    <div className="relative grid min-h-screen w-full place-items-center overflow-hidden bg-paper px-5 py-16 text-ink">
      <FloodlitBackdrop />

      <motion.main
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE_OUT }}
        className="relative w-full max-w-xl"
      >
        <Link
          to="/"
          className="mb-9 inline-flex items-center gap-2.5 focus-visible:outline
            focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          <img src="/favicon.svg" alt="" width={26} height={26} className="shrink-0" />
          <span className="font-display text-[18px] font-semibold tracking-[-0.02em]">
            FootyBoard
          </span>
        </Link>

        <div className="liquid-glass rounded-lg p-7 sm:p-9">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">{label}</p>

          <h1 className="mt-3 font-display text-[clamp(1.75rem,5vw,2.5rem)] font-medium leading-[1.05] tracking-[-0.03em]">
            {title}
          </h1>

          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-2">{lead}</p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/" className={buttonClass('primary', 'px-4 py-2.5 text-[14px]')}>
              Back to the front page
            </Link>
            <Link to="/board" className={buttonClass('secondary', 'px-4 py-2.5 text-[14px]')}>
              Open the board
            </Link>
          </div>
        </div>
      </motion.main>
    </div>
  )
}

/** What the catch-all route renders: an address that matches nothing here. */
export function NotFound() {
  return (
    <DeadEnd
      label="404"
      title="That page is not on the board."
      lead="Nothing lives at this address. A saved link may have gone stale, or a character may have gone astray on the way in. Everything you have saved is still where you left it."
    />
  )
}

/**
 * The router's own boundary, for anything a route throws on the way to
 * rendering. The board and the join page each keep their `ErrorBoundary`, which
 * catches a crash closer to where it happened and can offer a reload; this is
 * the net under every other route, and under the router itself.
 */
export function RouteError() {
  const error = useRouteError()

  // An unmatched path arrives here as a 404 response rather than as a crash,
  // which is a different thing to say to somebody even though the router
  // reports both through this one hook.
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />

  return (
    <DeadEnd
      label="This page stopped"
      title="That page did not load."
      lead={toUserMessage(
        error,
        'Something went wrong on the way to this page. Trying again often clears it.',
      )}
    />
  )
}
