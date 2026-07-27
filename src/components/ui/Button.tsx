import { motion } from 'framer-motion'
import type { HTMLMotionProps } from 'framer-motion'

export type Variant = 'primary' | 'secondary' | 'quiet'

const base =
  'inline-flex items-center justify-center gap-1.5 select-none rounded px-3 py-1.5 ' +
  'text-[13px] font-medium leading-none tracking-[-0.01em] ' +
  'transition-colors duration-150 ease-out ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent disabled:opacity-40 disabled:pointer-events-none'

const variants: Record<Variant, string> = {
  // Ink on the accent is the near-black ground, not the off-white: off-white on
  // signal green is 1.66:1, which is unreadable at any size.
  primary: 'bg-accent text-paper hover:bg-accent-hover shadow-1',
  secondary: 'bg-surface text-ink border border-rule hover:border-rule-strong shadow-1',
  quiet: 'bg-transparent text-ink-2 hover:text-ink hover:bg-[var(--accent-wash)]',
}

/**
 * The button's look and its press response, separately available.
 *
 * A popover's trigger has to be a real `<button>` of its own so it can carry
 * the open state a keyboard and a screen reader need; it borrows these rather
 * than nesting one button inside another.
 */
export const buttonClass = (variant: Variant = 'secondary', className = '') =>
  `${base} ${variants[variant]} ${className}`

export const pressMotion = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.96, y: 0 },
  transition: { type: 'spring', stiffness: 520, damping: 30, mass: 0.5 },
} as const

type Props = HTMLMotionProps<'button'> & { variant?: Variant }

export function Button({ variant = 'secondary', className = '', ...rest }: Props) {
  return (
    <motion.button
      type="button"
      {...pressMotion}
      {...rest}
      className={buttonClass(variant, className)}
    />
  )
}
