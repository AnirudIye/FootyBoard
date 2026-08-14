import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * The five footer links, which are flex items of a wrapping nav and so are
 * blockified into the reach of the 44px coarse-pointer floor in index.css.
 *
 * A name rather than the same string typed four times, because the reason it
 * carries `inline-flex items-center justify-center` is not guessable from any
 * one of them: 11px of type in a 44px box with no padding of its own left every
 * one of these labels flush against the top edge on a phone, 0px above and 29
 * below. A link gets no UA centring the way a `<button>` does. Inert on a
 * mouse, where the box is 16.5px — the height of its own line — and there is no
 * free space for `items-center` to distribute.
 */
const footerLink = 'inline-flex items-center justify-center transition-colors hover:text-accent'

/**
 * Shared shell for the policy pages: readable measure, quiet chrome.
 *
 * **`lede` is the sentence the prerendered document opens with, and rendering it
 * here is the whole reason the prop exists.** `scripts/prerender.mjs` writes a
 * one-line summary into the static copy of `/privacy`, `/terms`,
 * `/accessibility` and `/contact` — and until this prop, the React tree said
 * none of them. A crawler read a sentence no visitor was ever shown, which is
 * cloaking, and `src/content/marketing.js` forbids it in its own header.
 *
 * It is not merely a compliance fix. A legal page that opens with one line
 * saying what it is, before three thousand words of clauses, is better for
 * somebody who landed on it from a search and wants to know whether this is the
 * page they meant. Optional, because a caller with nothing summarisable to say
 * should say nothing rather than pad.
 */
export default function LegalPage({
  title,
  updated,
  lede,
  children,
}: {
  title: string
  updated: string
  lede?: string
  children: ReactNode
}) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" width={24} height={24} />
            <span className="font-display text-[17px] font-semibold tracking-[-0.02em]">
              FootyBoard
            </span>
          </Link>
          {/* A flex item, so blockified, so inside the reach of the 44px
              coarse-pointer floor in index.css — and a link has no UA rule
              centring its own content the way a `<button>` does, so this said
              "Open board" against the top edge of a 44px box. Inert on a
              mouse, where the box is the height of one line. */}
          <Link
            to="/board"
            className="inline-flex items-center justify-center font-mono text-[11px] uppercase
              tracking-[0.12em] text-ink-2 transition-colors hover:text-accent"
          >
            Open board
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-14">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.16em] text-accent">Legal</p>
        <h1 className="font-display text-[clamp(2rem,5vw,3rem)] font-medium leading-[1.05] tracking-[-0.03em]">
          {title}
        </h1>
        {lede && <p className="mt-4 max-w-[46rem] text-[15px] leading-relaxed text-ink-2">{lede}</p>}

        <p className="mt-3 font-mono text-[12px] text-ink-3">Last updated {updated}</p>

        <div className="legal mt-10 space-y-8">{children}</div>

        <footer className="mt-16 border-t border-rule pt-6">
          <nav className="flex flex-wrap gap-6 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3">
            <Link to="/privacy" className={footerLink}>
              Privacy Policy
            </Link>
            <Link to="/terms" className={footerLink}>
              Terms of Service
            </Link>
            <Link to="/accessibility" className={footerLink}>
              Accessibility
            </Link>
            <Link to="/contact" className={footerLink}>
              Contact
            </Link>
            <Link to="/" className={footerLink}>
              Home
            </Link>
          </nav>
        </footer>
      </main>
    </div>
  )
}

/** A titled block of policy text. */
export function Clause({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 font-display text-[19px] font-medium tracking-[-0.015em]">{heading}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </section>
  )
}
