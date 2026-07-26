declare module 'gifenc' {
  export interface WriteFrameOpts {
    palette?: number[][]
    delay?: number
    transparent?: boolean
    dispose?: number
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOpts): void
    finish(): void
    bytes(): Uint8Array<ArrayBuffer>
  }
  export function GIFEncoder(): Encoder
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number): number[][]
  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: number[][],
  ): Uint8Array
}
