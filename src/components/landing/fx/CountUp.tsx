import { useEffect, useRef, useState } from 'react'
import { animate, useInView } from 'framer-motion'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

interface Props {
  to: number
  suffix?: string
  prefix?: string
  decimals?: number
  duration?: number
  className?: string
}

/** Counts from zero up to `to` the first time it scrolls into view. */
export function CountUp({ to, suffix = '', prefix = '', decimals = 0, duration = 1.4, className = '' }: Props) {
  const reduced = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })
  const [value, setValue] = useState(reduced ? to : 0)

  useEffect(() => {
    if (reduced || !inView) return
    const controls = animate(0, to, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setValue(v),
    })
    return () => controls.stop()
  }, [inView, to, duration, reduced])

  return (
    <span ref={ref} className={className}>
      {prefix}
      {value.toFixed(decimals)}
      {suffix}
    </span>
  )
}
