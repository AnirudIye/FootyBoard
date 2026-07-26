export const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const roundTo = (v: number, step: number) => Math.round(v / step) * step
