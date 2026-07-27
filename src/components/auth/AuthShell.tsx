import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'

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
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[400px]"
      >
        <Link to="/" className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="font-display text-[18px] font-semibold tracking-[-0.02em]">
            Soccerboard
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
