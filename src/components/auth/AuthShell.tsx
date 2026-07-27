import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { EASE_OUT } from '../../theme/motion'

/** Shared frame for the sign-in, sign-up, password, and join pages. */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-paper px-5 py-12 text-ink">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE_OUT }}
        className="w-full max-w-[400px]"
      >
        <Link to="/" className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="font-display text-[18px] font-semibold tracking-[-0.02em]">
            FootyBoard
          </span>
        </Link>

        <h1 className="font-display text-[28px] font-medium leading-tight tracking-[-0.025em]">
          {title}
        </h1>

        {subtitle && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{subtitle}</p>}

        {children}
      </motion.div>
    </div>
  )
}

export const field =
  'w-full rounded border border-rule bg-sunken px-3 py-2 text-[14px] text-ink ' +
  'placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

/**
 * The submit button on every form in here. A class string rather than a
 * component, because the three forms wrap different elements around it and the
 * only thing they actually share is the look.
 */
export const submitBtn =
  'w-full rounded bg-accent px-4 py-2.5 text-[14px] font-medium text-paper ' +
  'transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent'

/**
 * Whatever went wrong, said where the eye already is. The accent wash rather
 * than a red: nothing on these forms is destructive, and it is the only alarm
 * the page has, so it has nothing to shout over.
 */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded border border-accent/40 bg-[var(--accent-wash)] px-3 py-2 text-[13px] leading-relaxed text-ink"
    >
      {children}
    </p>
  )
}
