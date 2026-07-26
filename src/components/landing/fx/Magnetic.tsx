import { useRef } from 'react'
import type { ReactNode } from 'react'
import { motion, useMotionValue, useSpring } from 'framer-motion'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

interface Props {
  children: ReactNode
  strength?: number
  className?: string
}

/** Leans toward the cursor while hovered and springs back on leave. */
export function Magnetic({ children, strength = 0.3, className = '' }: Props) {
  const reduced = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 260, damping: 18, mass: 0.4 })
  const sy = useSpring(y, { stiffness: 260, damping: 18, mass: 0.4 })

  if (reduced) return <span className={className}>{children}</span>

  return (
    <motion.span
      ref={ref}
      className={`inline-block ${className}`}
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        x.set((e.clientX - (r.left + r.width / 2)) * strength)
        y.set((e.clientY - (r.top + r.height / 2)) * strength)
      }}
      onPointerLeave={() => {
        x.set(0)
        y.set(0)
      }}
    >
      {children}
    </motion.span>
  )
}
