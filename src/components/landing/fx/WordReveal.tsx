import { motion } from 'framer-motion'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

interface Props {
  text: string
  className?: string
  delay?: number
  /** Emphasised words rendered in the accent ink. */
  accentWords?: string[]
}

/**
 * Splits a headline into words and rises each one in with a brief blur clear,
 * staggered. A tactile, editorial reveal rather than a generic fade.
 */
export function WordReveal({ text, className = '', delay = 0, accentWords = [] }: Props) {
  const reduced = useReducedMotion()
  const words = text.split(' ')
  const accent = new Set(accentWords.map((w) => w.toLowerCase()))

  if (reduced) {
    return (
      <span className={className}>
        {words.map((w, i) => (
          <span key={i} className={accent.has(w.toLowerCase()) ? 'text-accent' : undefined}>
            {w}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </span>
    )
  }

  return (
    <motion.span
      className={className}
      initial="hidden"
      animate="show"
      transition={{ staggerChildren: 0.055, delayChildren: delay }}
      aria-label={text}
    >
      {words.map((w, i) => (
        <span key={i} className="inline-block overflow-hidden align-baseline">
          <motion.span
            className={`inline-block ${accent.has(w.toLowerCase()) ? 'text-accent' : ''}`}
            variants={{
              hidden: { y: '105%', opacity: 0, filter: 'blur(6px)' },
              show: {
                y: '0%',
                opacity: 1,
                filter: 'blur(0px)',
                transition: { duration: 0.7, ease: EASE },
              },
            }}
            aria-hidden
          >
            {w}
            {i < words.length - 1 ? ' ' : ''}
          </motion.span>
        </span>
      ))}
    </motion.span>
  )
}
