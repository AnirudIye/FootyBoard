/**
 * Imperative handles the canvas publishes for chrome outside it (the toolbar
 * and frame strip) to call. Kept in a module rather than context because the
 * Konva stage lives inside a separate reconciler.
 */
export const boardHandles: {
  exportPng: (() => Promise<void>) | null
  exportSequence:
    | ((kind: 'gif' | 'webm', onProgress?: (fraction: number) => void) => Promise<void>)
    | null
  fitPitch: (() => void) | null
} = {
  exportPng: null,
  exportSequence: null,
  fitPitch: null,
}
