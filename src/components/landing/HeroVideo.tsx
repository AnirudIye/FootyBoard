import { useEffect, useRef } from 'react'
import { useReducedMotion } from '../../hooks/useReducedMotion'

const FADE = 0.5 // seconds at each end
const RESTART_DELAY = 100 // ms of black before it plays again

/**
 * The hero's background film. It starts at zero opacity and is faded in and
 * out by hand on a rAF loop — 0.5s up at the head, 0.5s down at the tail —
 * so the clip never hard-cuts back to its first frame. Deliberately no
 * gradient overlay: the blurred shape behind the copy does that work.
 */
export default function HeroVideo({ src, poster }: { src?: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const video = ref.current
    if (!video || !src) return

    // Reduced motion: hold a still frame rather than looping footage.
    if (reduced) {
      video.pause()
      video.style.opacity = '0.5'
      return
    }

    let raf = 0
    let restart: number | undefined

    const tick = () => {
      const { currentTime, duration } = video
      if (duration > 0) {
        const fadeIn = Math.min(1, currentTime / FADE)
        const fadeOut = Math.min(1, Math.max(0, (duration - currentTime) / FADE))
        video.style.opacity = String(Math.min(fadeIn, fadeOut))
      }
      raf = requestAnimationFrame(tick)
    }

    const onEnded = () => {
      video.style.opacity = '0'
      restart = window.setTimeout(() => {
        video.currentTime = 0
        void video.play().catch(() => {})
      }, RESTART_DELAY)
    }

    video.addEventListener('ended', onEnded)
    void video.play().catch(() => {
      // Autoplay refused (or the file is unreachable): the backdrop stands in.
    })
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      if (restart) window.clearTimeout(restart)
      video.removeEventListener('ended', onEnded)
    }
  }, [src, reduced])

  if (!src) return null

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      playsInline
      preload="auto"
      aria-hidden
      className="absolute inset-0 h-full w-full object-cover"
      style={{ opacity: 0 }}
    />
  )
}
