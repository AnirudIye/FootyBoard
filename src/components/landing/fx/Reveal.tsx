import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

interface Props {
  children: ReactNode
  delay?: number
  y?: number
  className?: string
  as?: 'div' | 'section' | 'li' | 'span'
}

/** Fades and rises its children into view once, when scrolled to. */
export function Reveal({ children, delay = 0, y = 22, className = '', as = 'div' }: Props) {
  const reduced = useReducedMotion()
  const MotionTag = motion[as]

  if (reduced) {
    const Tag = as
    return <Tag className={className}>{children}</Tag>
  }

  return (
    <MotionTag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </MotionTag>
  )
}

/** A container that staggers its direct <Reveal>-style children into view. */
export function RevealGroup({
  children,
  className = '',
  stagger = 0.08,
}: {
  children: ReactNode
  className?: string
  stagger?: number
}) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-60px' }}
      variants={{ show: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </motion.div>
  )
}

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

export const revealItem = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
}
