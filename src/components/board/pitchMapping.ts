import type { PitchView, PitchKind } from '../../lib/types'
import type { PitchBox } from '../../lib/geometry'
import { lerp } from '../../lib/math'

// Real pitch dimensions in metres (length x width).
const DIMS: Record<PitchKind, { L: number; W: number }> = {
  '11': { L: 105, W: 68 },
  '7aside': { L: 60, W: 40 },
  futsal: { L: 40, W: 20 },
}

// Which slice of the pitch length (0..100) a view shows.
const DOMAIN: Record<PitchView, [number, number]> = {
  fullH: [0, 100],
  fullV: [0, 100],
  attackHalf: [50, 100],
  defendHalf: [0, 50],
  blank: [0, 100],
}

export interface PitchMapping {
  box: PitchBox
  orientation: 'h' | 'v'
  /** 0 for horizontal, 90 for vertical. Blended during transitions so that
   *  direction-dependent details (penalty arcs) rotate smoothly. */
  orientDeg: number
  ppm: number // pixels per metre (equal on both axes)
  L: number
  W: number
  view: PitchView
  kind: PitchKind
  /** Map a normalized board coordinate (0..100, 0..100) to pixels. */
  toPx: (nx: number, ny: number) => { x: number; y: number }
  /** Invert a pixel coordinate back to a normalized board coordinate. */
  toNorm: (px: number, py: number) => { x: number; y: number }
}

export function computeMapping(
  view: PitchView,
  kind: PitchKind,
  stageW: number,
  stageH: number,
): PitchMapping {
  const { L, W } = DIMS[kind]
  const [x0, x1] = DOMAIN[view]
  const domainFrac = (x1 - x0) / 100
  const drawnLength = L * domainFrac
  const domainStartM = (x0 / 100) * L
  const orientation: 'h' | 'v' = view === 'fullV' ? 'v' : 'h'

  const ratio = orientation === 'h' ? drawnLength / W : W / drawnLength // w:h

  const margin = 0.9
  const availW = stageW * margin
  const availH = stageH * margin
  let w: number
  let h: number
  if (availW / availH > ratio) {
    h = availH
    w = ratio * h
  } else {
    w = availW
    h = w / ratio
  }
  const box: PitchBox = { x: (stageW - w) / 2, y: (stageH - h) / 2, w, h }
  const ppm = orientation === 'h' ? box.w / drawnLength : box.h / drawnLength

  // Absolute metres to pixels. Everything on the board is positioned in
  // normalized units, so this stays inside the module.
  const m2px = (lengthM: number, widthM: number) =>
    orientation === 'h'
      ? { x: box.x + (lengthM - domainStartM) * ppm, y: box.y + widthM * ppm }
      : { x: box.x + widthM * ppm, y: box.y + (lengthM - domainStartM) * ppm }

  const toPx = (nx: number, ny: number) => m2px((nx / 100) * L, (ny / 100) * W)

  const toNorm = (px: number, py: number) => {
    let lm: number
    let wm: number
    if (orientation === 'h') {
      lm = (px - box.x) / ppm + domainStartM
      wm = (py - box.y) / ppm
    } else {
      wm = (px - box.x) / ppm
      lm = (py - box.y) / ppm + domainStartM
    }
    return { x: (lm / L) * 100, y: (wm / W) * 100 }
  }

  return {
    box,
    orientation,
    orientDeg: orientation === 'v' ? 90 : 0,
    ppm,
    L,
    W,
    view,
    kind,
    toPx,
    toNorm,
  }
}

/**
 * How many board units one CSS pixel covers, asked separately of each screen
 * axis.
 *
 * Anything sized for a hand — a grab target, an eraser disc — is specified in
 * CSS pixels, because that is the only unit a finger has. Anything compared
 * against a drawing has to be in board units, because that is what a drawing
 * stores. This is the bridge, and it is worth having in one place for two
 * reasons that are each a bug on their own.
 *
 * **The screen axes swap with the orientation.** On `fullV` a step along screen
 * x moves the pointer across the pitch's *width*, which is the board's y. So
 * `toNorm(px + r, py).x - toNorm(px, py).x` — the obvious way to write this — is
 * not merely a different number on a vertical pitch, it is exactly nought, and a
 * disc sized from it would touch nothing at all. Taking the magnitude of the
 * whole delta asks "how far did the board move", which is the question, and it
 * needs no case for the orientation.
 *
 * **The stage is scaled.** Pan and zoom mean a length of `s` in the coordinates
 * `toNorm` reads reaches the eye as `s * zoom` CSS pixels, so the probe steps
 * `1 / zoom` — the same division `DrawingShape` and `PropToken` do to keep their
 * handles a constant size on screen.
 *
 * The two answers are not interchangeable. A board unit is a hundredth of the
 * pitch *length* in x and a hundredth of its *width* in y, and 105 metres is not
 * 68, so a disc of one radius in board units is an ellipse on the glass. What to
 * do about that is the caller's decision; see `PitchCanvas`.
 */
export function boardPerPixel(m: PitchMapping, zoom: number): { x: number; y: number } {
  const step = 1 / zoom
  const o = m.toNorm(0, 0)
  const ax = m.toNorm(step, 0)
  const ay = m.toNorm(0, step)
  return {
    x: Math.hypot(ax.x - o.x, ax.y - o.y),
    y: Math.hypot(ay.x - o.x, ay.y - o.y),
  }
}

/**
 * Blend two mappings by interpolating the pixel positions they produce. Because
 * every drawn element is positioned through toPx, this morphs the whole pitch
 * (size, orientation, and view crop) as a single continuous motion.
 * Pointer conversion always uses the target so drops land in the new geometry.
 */
export function blendMappings(a: PitchMapping, b: PitchMapping, t: number): PitchMapping {
  if (t >= 1) return b
  if (t <= 0) return a
  return {
    ...b,
    box: {
      x: lerp(a.box.x, b.box.x, t),
      y: lerp(a.box.y, b.box.y, t),
      w: lerp(a.box.w, b.box.w, t),
      h: lerp(a.box.h, b.box.h, t),
    },
    orientDeg: lerp(a.orientDeg, b.orientDeg, t),
    ppm: lerp(a.ppm, b.ppm, t),
    toPx: (nx, ny) => {
      const pa = a.toPx(nx, ny)
      const pb = b.toPx(nx, ny)
      return { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t) }
    },
    toNorm: b.toNorm,
  }
}
