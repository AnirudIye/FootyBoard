import { useEffect, useRef } from 'react'
import { useBoardStore } from '../store/boardStore'

const SECONDS_PER_FRAME = 1.1

/**
 * Advances the playhead while playing. Runs a rAF clock that moves
 * `playback.position` across the sequence at the current speed, looping or
 * stopping at the end. Scrubbing sets the position directly and does not need
 * this hook.
 */
export function usePlayback() {
  const playing = useBoardStore((s) => s.playback.playing)
  const speed = useBoardStore((s) => s.playback.speed)
  const loop = useBoardStore((s) => s.playback.loop)
  const frameCount = useBoardStore((s) => s.frames.length)
  const setPlayback = useBoardStore((s) => s.setPlayback)

  const raf = useRef<number | null>(null)
  const last = useRef<number>(0)

  useEffect(() => {
    if (!playing || frameCount < 2) return
    const maxPos = frameCount - 1
    last.current = performance.now()

    // If we are already at the end, restart from the top.
    if (useBoardStore.getState().playback.position >= maxPos) {
      setPlayback({ position: 0 })
    }

    const tick = (now: number) => {
      const dt = (now - last.current) / 1000
      last.current = now
      const cur = useBoardStore.getState().playback.position
      let next = cur + (dt / SECONDS_PER_FRAME) * speed

      if (next >= maxPos) {
        if (loop) {
          next = next % maxPos
        } else {
          setPlayback({ position: maxPos, playing: false })
          return
        }
      }
      setPlayback({ position: next })
      raf.current = requestAnimationFrame(tick)
    }

    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [playing, speed, loop, frameCount, setPlayback])
}
