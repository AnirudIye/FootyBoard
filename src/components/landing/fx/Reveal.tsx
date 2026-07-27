import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { EASE_OUT } from '../../../theme/motion'

interface Props {
  children: ReactNode
  delay?: number
  y?: number
  className?: string
}

/** Fades and rises its children into view once, when scrolled to. */
export function Reveal({ children, delay = 0, y = 22, className = '' }: Props) {
  const reduced = useReducedMotion()

  if (reduced) return <div className={className}>{children}</div>

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, ease: EASE_OUT, delay }}
    >
      {children}
    </motion.div>
  )
}
