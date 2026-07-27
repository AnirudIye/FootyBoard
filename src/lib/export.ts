import type Konva from 'konva'
import { AppError } from './errors'

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

function download(dataUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Renders the pitch region of the stage to a high-resolution PNG on the paper
 * ground, with a small wordmark in the corner, and triggers a download.
 * Throws if the browser refuses to rasterise the canvas.
 */
export async function exportBoardPng(
  stage: Konva.Stage,
  crop: CropRect,
  filename = 'footyboard.png',
  pixelRatio = 2,
): Promise<void> {
  const pad = 24
  // Konva hands back the element directly. The round trip this replaces went
  // stage -> data URL -> Image -> decode -> a second canvas, which is three
  // encodes and a decode to reach a bitmap the stage already had.
  const board = stage.toCanvas({
    x: crop.x - pad,
    y: crop.y - pad,
    width: crop.width + pad * 2,
    height: crop.height + pad * 2,
    pixelRatio,
  }) as HTMLCanvasElement

  const canvas = document.createElement('canvas')
  canvas.width = board.width
  canvas.height = board.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AppError("This browser wouldn't produce an image of the board. Reload the page, then export again.")

  // The board is drawn over an opaque ground rather than exported with a
  // transparent one, so a PNG dropped into a document or a chat reads the same
  // way it did on screen.
  ctx.fillStyle = '#f4f1ea'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(board, 0, 0)

  const size = Math.max(11, Math.round(canvas.height * 0.021))
  // Geist Sans, matching the sequence exports and the rest of the product.
  // This said Archivo until the font audit: `@fontsource/archivo` was a
  // dependency that `src/theme/fonts.ts` never imported, so the face was never
  // loaded and every PNG silently fell back to system-ui. That made the
  // watermark a different shape on a Mac than on Windows, and different again
  // from the GIF and WebM exports, which name the loaded face.
  ctx.font = `500 ${size}px 'Geist Sans', ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(23,25,29,0.4)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText('footyboard', canvas.width - size, canvas.height - size * 0.7)

  download(canvas.toDataURL('image/png'), filename)
}
