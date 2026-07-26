import type { PitchView, PitchKind } from '../../lib/types'
import type { PitchBox } from '../../lib/geometry'

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
  domainStartM: number
  view: PitchView
  kind: PitchKind
  /** Map a point given in absolute metres (alongLength, alongWidth) to pixels. */
  m2px: (lengthM: number, widthM: number) => { x: number; y: number }
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
    domainStartM,
    view,
    kind,
    m2px,
    toPx,
    toNorm,
  }
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t

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
      x: mix(a.box.x, b.box.x, t),
      y: mix(a.box.y, b.box.y, t),
      w: mix(a.box.w, b.box.w, t),
      h: mix(a.box.h, b.box.h, t),
    },
    orientDeg: mix(a.orientDeg, b.orientDeg, t),
    ppm: mix(a.ppm, b.ppm, t),
    m2px: (lengthM, widthM) => {
      const pa = a.m2px(lengthM, widthM)
      const pb = b.m2px(lengthM, widthM)
      return { x: mix(pa.x, pb.x, t), y: mix(pa.y, pb.y, t) }
    },
    toPx: (nx, ny) => {
      const pa = a.toPx(nx, ny)
      const pb = b.toPx(nx, ny)
      return { x: mix(pa.x, pb.x, t), y: mix(pa.y, pb.y, t) }
    },
    toNorm: b.toNorm,
  }
}
