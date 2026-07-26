import type { Token, Frame, FrameTokenState } from './types'
import { clamp, lerp } from './math'

/** Snapshot the positions of every token on the board. */
export function captureFrame(tokens: Token[]): Record<string, FrameTokenState> {
  const out: Record<string, FrameTokenState> = {}
  for (const t of tokens) out[t.id] = { x: t.x, y: t.y, rotation: t.rotation }
  return out
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/**
 * Positions to draw the tokens at for a fractional playhead `t` in
 * [0, frames.length-1]. Tokens absent from the surrounding frames keep their
 * live board position, so props added after a frame was captured do not jump.
 */
export function interpolateFrames(
  frames: Frame[],
  tokens: Token[],
  t: number,
  eased = false,
): Record<string, FrameTokenState> {
  const live = captureFrame(tokens)
  if (frames.length === 0) return live
  if (frames.length === 1) return { ...live, ...frames[0].tokens }

  const clamped = clamp(t, 0, frames.length - 1)
  const i = Math.min(Math.floor(clamped), frames.length - 2)
  const rawFrac = clamped - i
  const frac = eased ? easeInOut(rawFrac) : rawFrac

  const a = frames[i].tokens
  const b = frames[i + 1].tokens
  const out: Record<string, FrameTokenState> = {}

  for (const tok of tokens) {
    const from = a[tok.id]
    const to = b[tok.id]
    if (from && to) {
      out[tok.id] = {
        x: lerp(from.x, to.x, frac),
        y: lerp(from.y, to.y, frac),
        rotation: lerp(from.rotation, to.rotation, frac),
      }
    } else {
      out[tok.id] = from ?? to ?? live[tok.id]
    }
  }
  return out
}

/** Total playback seconds for a sequence at the given per-frame duration. */
export const sequenceDuration = (frameCount: number, secondsPerFrame: number): number =>
  Math.max(0, frameCount - 1) * secondsPerFrame
