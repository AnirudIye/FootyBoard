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

/**
 * Press feedback, and deliberately no hover motion.
 *
 * There was a one-pixel hover lift here. This is the shared button, so it fired
 * on the toolbar row, the frame strip controls, the share dialog, the board
 * picker, the auth pages and every popover trigger — a coach's pointer crosses
 * the toolbar dozens of times a session, and each crossing set a spring running
 * on something nobody was looking at. The `hover:` colour change in `base` is
 * the affordance; this is the feedback.
 *
 * `y: 0` went with it. It was only there to cancel the lift.
 *
 * The spring stays hand-typed rather than becoming `SPRING_SNAP`. The two are not
 * the same spring — `{bounce, duration}` and `{stiffness, damping, mass}` solve
 * to different curves here — so swapping it changes the feel of every press in
 * the product, which is a separate decision from removing a hover.
 */
export const pressMotion = {
  whileTap: { scale: 0.96 },
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
