import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import type Konva from 'konva'
import { useBoardStore } from '../../store/boardStore'
import { sequenceDuration } from '../../lib/frames'
import { AppError } from '../../lib/errors'

export interface Crop {
  x: number
  y: number
  width: number
  height: number
}

const SECONDS_PER_FRAME = 1.1
const MAX_WIDTH = 640

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Target size for the exported media, capped and even for encoder friendliness. */
function targetSize(crop: Crop) {
  const scale = Math.min(1, MAX_WIDTH / crop.width)
  const w = Math.max(2, Math.round((crop.width * scale) / 2) * 2)
  const h = Math.max(2, Math.round((crop.height * scale) / 2) * 2)
  return { w, h }
}

function watermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const size = Math.max(10, Math.round(h * 0.045))
  ctx.font = `500 ${size}px Archivo, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(23,25,29,0.4)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText('soccerboard', w - size, h - size * 0.6)
}

/**
 * Yield long enough for React to commit the store change.
 *
 * The board is drawn by react-konva, which runs its own reconciler — so
 * `flushSync` from react-dom does not flush it, and reading pixels straight
 * after a store update captures the previous frame every time. Handing control
 * back to the task queue lets the commit land. A macrotask rather than rAF, so
 * an export still finishes when the tab is in the background.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Render the interpolated frame at `pos` onto `ctx`. */
async function paintFrame(
  stage: Konva.Stage,
  crop: Crop,
  pos: number,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  useBoardStore.getState().setPlayback({ position: pos, playing: false })
  await settle()
  stage.draw()
  const frame = stage.toCanvas({
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
    pixelRatio: 1,
  }) as HTMLCanvasElement
  ctx.fillStyle = '#f4f1ea'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(frame, 0, 0, w, h)
  watermark(ctx, w, h)
}

export interface SequenceOpts {
  frameCount: number
  speed: number
  fps?: number
}

export async function exportSequenceGif(
  stage: Konva.Stage,
  crop: Crop,
  { frameCount, speed, fps = 20 }: SequenceOpts,
  filename = 'soccerboard.gif',
): Promise<void> {
  if (frameCount < 2)
    throw new AppError('A GIF needs at least two frames. Capture another position with + Frame, then export.')
  const { w, h } = targetSize(crop)
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const ctx = tmp.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new AppError("This browser wouldn't produce an image of the board. Reload the page, then export again.")

  const seconds = sequenceDuration(frameCount, SECONDS_PER_FRAME) / speed
  const steps = Math.max(2, Math.round(seconds * fps))
  const delay = Math.round(1000 / fps)

  const gif = GIFEncoder()
  const restore = useBoardStore.getState().playback.position

  try {
    for (let i = 0; i <= steps; i++) {
      const pos = (i / steps) * (frameCount - 1)
      // Awaiting here is what makes each frame distinct — see paintFrame.
      await paintFrame(stage, crop, pos, ctx, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      const palette = quantize(data, 256)
      const index = applyPalette(data, palette)
      gif.writeFrame(index, w, h, { palette, delay })
    }
    gif.finish()
    download(new Blob([gif.bytes()], { type: 'image/gif' }), filename)
  } finally {
    useBoardStore.getState().setPlayback({ position: restore })
  }
}

function pickMime(): string | null {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ]
  const R = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
  if (!R) return null
  return candidates.find((c) => R.isTypeSupported(c)) ?? null
}

export async function exportSequenceWebm(
  stage: Konva.Stage,
  crop: Crop,
  { frameCount, speed, fps = 30 }: SequenceOpts,
  filename = 'soccerboard.webm',
): Promise<void> {
  if (frameCount < 2)
    throw new AppError('A video needs at least two frames. Capture another position with + Frame, then export.')
  const mimeType = pickMime()
  if (!mimeType)
    throw new AppError("This browser can't record video. Export a GIF instead, or try Chrome or Edge.")

  const { w, h } = targetSize(crop)
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const ctx = tmp.getContext('2d')
  if (!ctx) throw new AppError("This browser wouldn't produce an image of the board. Reload the page, then export again.")

  const stream = tmp.captureStream(fps)
  const chunks: BlobPart[] = []
  const rec = new MediaRecorder(stream, { mimeType })
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const durationMs = (sequenceDuration(frameCount, SECONDS_PER_FRAME) / speed) * 1000
  const restore = useBoardStore.getState().playback.position
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
  const outName = filename.replace(/\.\w+$/, `.${ext}`)

  const done = new Promise<void>((resolve) => {
    rec.onstop = () => {
      download(new Blob(chunks, { type: mimeType }), outName)
      resolve()
    }
  })

  rec.start()
  const start = performance.now()
  // Walk the sequence in real time, awaiting each paint so the recorder gets
  // the frame it is being shown rather than the one before it.
  for (;;) {
    const t = Math.min(1, (performance.now() - start) / durationMs)
    await paintFrame(stage, crop, t * (frameCount - 1), ctx, w, h)
    if (t >= 1) break
  }
  rec.stop()
  useBoardStore.getState().setPlayback({ position: restore })
  await done
}
