import { motion, useScroll, useSpring } from 'framer-motion'
import { useReducedMotion } from '../../hooks/useReducedMotion'

/**
 * How far through the page you are, drawn as a floodlit line under the
 * masthead. Scroll-linked rather than time-based, so it is always truthful and
 * interruptible — dragging the scrollbar backwards runs it backwards.
 */
export default function ScrollProgress() {
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll()
  // A light spring takes the jitter out of trackpad scrolling without lagging.
  const scaleX = useSpring(scrollYProgress, { stiffness: 220, damping: 40, mass: 0.4 })

  if (reduced) return null

  return (
    <motion.div
      aria-hidden
      style={{ scaleX, transformOrigin: '0% 50%' }}
      className="fixed inset-x-0 top-0 z-40 h-[2px] bg-accent"
    />
  )
}
