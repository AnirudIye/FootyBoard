import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** Shared shell for the policy pages: readable measure, quiet chrome. */
export default function LegalPage({
  title,
  updated,
  children,
}: {
  title: string
  updated: string
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
          <Link
            to="/board"
            className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-2 transition-colors hover:text-accent"
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
        <p className="mt-3 font-mono text-[12px] text-ink-3">Last updated {updated}</p>

        <div className="legal mt-10 space-y-8">{children}</div>

        <footer className="mt-16 border-t border-rule pt-6">
          <nav className="flex flex-wrap gap-6 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3">
            <Link to="/privacy" className="transition-colors hover:text-accent">
              Privacy Policy
            </Link>
            <Link to="/terms" className="transition-colors hover:text-accent">
              Terms of Service
            </Link>
            <Link to="/accessibility" className="transition-colors hover:text-accent">
              Accessibility
            </Link>
            <Link to="/" className="transition-colors hover:text-accent">
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
