import { motion } from 'framer-motion'
import type { HTMLMotionProps } from 'framer-motion'

type Variant = 'primary' | 'secondary' | 'quiet' | 'heroSecondary'

const base =
  'inline-flex items-center justify-center gap-1.5 select-none rounded px-3 py-1.5 ' +
  'text-[13px] font-medium leading-none tracking-[-0.01em] ' +
  'transition-colors duration-150 ease-out ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent disabled:opacity-40 disabled:pointer-events-none'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-[#fbf9f5] hover:bg-accent-hover shadow-1',
  secondary: 'bg-surface text-ink border border-rule hover:border-rule-strong shadow-1',
  quiet: 'bg-transparent text-ink-2 hover:text-ink hover:bg-[var(--accent-wash)]',
  // The hero's glass button: no fill, a lit rim, and a green wash on hover.
  heroSecondary: 'liquid-glass text-foreground hover:bg-[var(--accent-wash)]',
}

type Props = HTMLMotionProps<'button'> & { variant?: Variant }

export function Button({ variant = 'secondary', className = '', ...rest }: Props) {
  return (
    <motion.button
      type="button"
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.96, y: 0 }}
      transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.5 }}
      {...rest}
      className={`${base} ${variants[variant]} ${className}`}
    />
  )
}
