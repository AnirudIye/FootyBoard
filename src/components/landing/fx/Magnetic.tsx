import { useRef } from 'react'
import type { ReactNode } from 'react'
import { motion, useMotionValue, useSpring } from 'framer-motion'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { SPRING_SNAP } from '../../../theme/motion'

/** How far it leans, as a fraction of the cursor's offset from the centre. */
const STRENGTH = 0.3

/** Leans toward the cursor while hovered and springs back on leave. */
export function Magnetic({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, SPRING_SNAP)
  const sy = useSpring(y, SPRING_SNAP)

  if (reduced) return <span>{children}</span>

  return (
    <motion.span
      ref={ref}
      className="inline-block"
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        x.set((e.clientX - (r.left + r.width / 2)) * STRENGTH)
        y.set((e.clientY - (r.top + r.height / 2)) * STRENGTH)
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
