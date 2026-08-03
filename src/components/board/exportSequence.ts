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

export type SequenceKind = 'gif' | 'webm'

const SECONDS_PER_FRAME = 1.1

/**
 * How wide each format's output may be, and how far past the board's on-screen
 * size a video may be rendered to get there.
 *
 * These were one shared 640 until the two complaints that produced this change
 * — a GIF that made the page lag and a video that came out soft — because the
 * two formats want opposite things and one number could only answer one of them.
 *
 * A GIF pays for every pixel three times: read back off the canvas, mapped to a
 * palette index, then compressed into its own LZW stream. And the file is the
 * thing somebody has to send. Measured on a three-frame sequence over a 1048px
 * pitch, 45 written frames: 640 wide is 769 KB and holds the main thread for at
 * most 34 ms at a time; the same sequence at 1280 is 1.86 MB and 96 ms. So the
 * GIF keeps the old width, and its lag is fixed by doing less work per pixel
 * rather than by taking pixels away.
 *
 * A video pays for a frame once, at an encoder built for it, and the walk is
 * real time — so a bigger frame costs paint time and nothing else. The same
 * sequence at 1280 wide is 157 KB against 73 KB at 640, for four times the
 * pixels, and both saturate the 30fps capture. That is where "low quality" came
 * from: a 1048px board was shrunk to 640 and then stretched back out again by
 * whoever watched it.
 *
 * `VIDEO_SCALE` is what a *small* board gets. A pitch that is 400px wide on a
 * phone is rendered at 800 rather than left at 400, because the board is vector
 * art: re-rasterising it at twice the size resolves detail that upscaling the
 * result could not invent. The cap is what stops a wide monitor turning that
 * into a 5000px frame nothing wants to encode.
 */
const GIF_MAX_WIDTH = 640
const VIDEO_MAX_WIDTH = 1280
const VIDEO_SCALE = 2

// A GIF's palette and per-frame delay make anything smoother expensive for
// little gain; a video is cheap enough to run at screen rate.
const GIF_FPS = 20
const WEBM_FPS = 30

/**
 * How many moments across the sequence the GIF's one palette is built from.
 *
 * **A GIF has exactly one palette here, and that is a correctness requirement
 * rather than a saving.** gifenc writes the first frame's palette as the global
 * colour table and gives a local table only to a later frame that carries one
 * (`useLocalColorTable = Boolean(palette) && !first`) — so a frame written
 * *without* a palette is decoded against the **global** table, not against
 * whichever local table came before it. Refreshing the palette every second and
 * carrying it only on the frames that computed one therefore indexed nineteen
 * frames in twenty against a table the decoder was not using. It shipped, and it
 * looked exactly like what it was: the pitch lines went red and the home shirts
 * went grey between one refresh and the next, and came right for a single frame
 * each time a new table was written.
 *
 * So the palette is computed once, before the walk, and every frame indexes it.
 * It is built from several moments rather than from frame zero because the board
 * is not one still: a half view hides the off-half players, so a token can walk
 * into shot wearing a colour the first frame never contained, and quantising
 * frame zero alone would have no entry near it. Sampling start, end and two
 * points between costs four extra paints — about a tenth of a second — and is
 * the whole of what the interval was trying to buy.
 */
const PALETTE_SAMPLES = 4

/**
 * The ceiling handed to the recorder, scaled to the frame it is encoding.
 *
 * Left unset it was whatever the browser picked, and in Chromium that turned
 * out to be fine: asking for 8 Mbps at 1048px wide changed the file by less
 * than the run-to-run noise, because its default already scales with the frame.
 * So this is not what "low quality" was, and it is not what fixed it. It is set
 * because the frame is now four times the pixels it was, and a browser whose
 * default is a flat number rather than a per-pixel one would have that number
 * become the binding constraint exactly when the picture got bigger. A ceiling
 * costs nothing while it is not reached.
 */
const VIDEO_BITS_PER_PIXEL = 0.2

const NO_CANVAS =
  "This browser wouldn't produce an image of the board. Reload the page, then export again."

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

/** How big one exported frame is, and what Konva is asked to rasterise it at. */
export interface FrameGeometry {
  width: number
  height: number
  /** What to hand `stage.toCanvas`, so it draws the board at the output size. */
  pixelRatio: number
}

/**
 * The size a frame is rendered and encoded at: `scale` times the board's
 * on-screen size, held under `maxWidth`, and even on both axes because encoders
 * prefer it that way.
 *
 * `pixelRatio` comes out of the width rather than being fixed at 1, and that is
 * the point of this function. Rendering the stage at its on-screen size and
 * letting `drawImage` shrink the result put a bilinear filter between the board
 * and the file: at 640 from a 1048px pitch every hairline and every shirt
 * number arrived soft, because a 1px line sampled at 0.61 has nowhere to go.
 * Asking Konva for the output size instead re-rasterises the vectors at that
 * size, which resolves them properly.
 *
 * The saving is in the file rather than the clock. At an identical 640x414 the
 * same 45 frames came out at 802 KB instead of 919, because a bilinear shrink
 * turns every clean edge into a short gradient and LZW has to spell each one
 * out. Wall clock moved by less than the spread between two runs of the same
 * export, so it is not claimed here: Konva draws 2.7x fewer pixels but a canvas
 * this size was never where the time went.
 *
 * A crop with no width would divide by zero, so it renders 1:1 and lets the 2px
 * floor produce something rather than a NaN-sized canvas.
 */
export function frameGeometry(crop: Crop, maxWidth: number, scale = 1): FrameGeometry {
  const s = crop.width > 0 ? Math.min(scale, maxWidth / crop.width) : 1
  const width = Math.max(2, Math.round((crop.width * s) / 2) * 2)
  const height = Math.max(2, Math.round((crop.height * s) / 2) * 2)
  return { width, height, pixelRatio: crop.width > 0 ? width / crop.width : 1 }
}

/**
 * The most frames a GIF may be, however long the storyboard is.
 *
 * Everything else here made each frame cheaper. This is the only thing that
 * bounds how many there are, and without it the cost is simply linear in the
 * length of the sequence: at 20fps a twelve-frame storyboard is 242 written
 * frames, and every one of them is a paint, a `getImageData`, a palette mapping
 * and an LZW pass. Projected from the measured 29ms per frame that is **seven
 * seconds of blocked main thread and a 4.1 MB file**, and a twenty-frame one is
 * twelve seconds and 7 MB. The complaint that started this work was that the
 * GIF maker makes the page lag; a sixteen percent saving does not answer that
 * for anybody whose sequence is long, and nothing in the format degrades
 * gracefully on its own.
 *
 * 150 holds the worst case to about 4.4 seconds and 2.5 MB. Under about eight
 * captured frames nothing is capped at all and the export is exactly what it
 * was; past that the GIF loses frame rate rather than losing time, which is the
 * trade worth making for a thing whose purpose is being sent to somebody.
 */
const GIF_MAX_FRAMES = 150

/**
 * The last index of the GIF's walk. It writes `steps + 1` frames, because the
 * walk includes both ends of the sequence.
 */
export function gifSteps(frameCount: number, speed: number): number {
  const seconds = sequenceDuration(frameCount, SECONDS_PER_FRAME) / speed
  return Math.max(2, Math.min(GIF_MAX_FRAMES, Math.round(seconds * GIF_FPS)))
}

/**
 * Milliseconds to hold each written frame, derived from the walk rather than
 * from `GIF_FPS`.
 *
 * The two agreed exactly while `steps` was `seconds * GIF_FPS`, so a constant
 * `1000 / GIF_FPS` was right by construction. The cap breaks that agreement:
 * a capped sequence has fewer frames covering the same seconds, so a fixed
 * delay would play it back short and fast — a twenty-frame storyboard would
 * arrive as a seven-second GIF of a twenty-one-second move. Dividing the
 * duration by the frames actually written keeps a GIF the length of the
 * sequence it is a picture of, and lets the cap cost frame rate and nothing
 * else.
 */
export function gifDelay(frameCount: number, speed: number, steps: number): number {
  const seconds = sequenceDuration(frameCount, SECONDS_PER_FRAME) / speed
  return Math.max(1, Math.round((seconds * 1000) / steps))
}

/**
 * Which steps of the walk are painted to build the palette from, evenly spaced
 * across the sequence and always including both ends.
 *
 * De-duplicated, because a two-step walk asked for four samples would otherwise
 * quantise the same frame twice for nothing.
 */
export function paletteSampleSteps(steps: number, samples = PALETTE_SAMPLES): number[] {
  const n = Math.max(1, Math.min(samples, steps + 1))
  if (n === 1) return [0]
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.round((i / (n - 1)) * steps))
  return [...new Set(out)]
}

/** The recorder's ceiling for a frame this size. See `VIDEO_BITS_PER_PIXEL`. */
export const videoBitrate = ({ width, height }: FrameGeometry): number =>
  Math.round(width * height * WEBM_FPS * VIDEO_BITS_PER_PIXEL)

/** The scratch canvas every frame is composed on. */
function makeCanvas({ width, height }: FrameGeometry, willReadFrequently = false) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently })
  if (!ctx) throw new AppError(NO_CANVAS)
  return { canvas, ctx }
}

function watermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const size = Math.max(10, Math.round(h * 0.045))
  ctx.font = `500 ${size}px Geist Sans, ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(23,25,29,0.4)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText('footyboard', w - size, h - size * 0.6)
}

/**
 * Yield long enough for React to commit the store change.
 *
 * The board is drawn by react-konva, which runs its own reconciler — so
 * `flushSync` from react-dom does not flush it, and reading pixels straight
 * after a store update captures the previous frame every time. Handing control
 * back to the task queue lets the commit land. A macrotask rather than rAF, so
 * an export still finishes when the tab is in the background.
 *
 * It is also the only thing that keeps the page alive during an export, so what
 * sits between two of these is the whole of what "laggy" means here. About half
 * of it is the commit this waits for, which cannot be moved off this thread by
 * any means: it is React and Konva drawing the board, the same work as showing
 * it. A worker could only ever take the encoding, which after this change is
 * around four of the twenty-eight milliseconds.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Render the interpolated frame at `pos` onto `ctx`. */
async function paintFrame(
  stage: Konva.Stage,
  crop: Crop,
  pos: number,
  ctx: CanvasRenderingContext2D,
  { width, height, pixelRatio }: FrameGeometry,
) {
  useBoardStore.getState().setPlayback({ position: pos, playing: false })
  await settle()
  stage.draw()
  const frame = stage.toCanvas({
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
    pixelRatio,
  }) as HTMLCanvasElement
  ctx.fillStyle = '#f4f1ea'
  ctx.fillRect(0, 0, width, height)
  // Given the output size rather than drawn at its natural one: rounding the
  // canvas to even axes can leave Konva's result a pixel short, and a frame
  // that did not fill the canvas would show the ground through one edge.
  ctx.drawImage(frame, 0, 0, width, height)
  watermark(ctx, width, height)
}

export interface SequenceOpts {
  frameCount: number
  speed: number
}

/** Export the captured frames as one moving image, in whichever format. */
export function exportSequence(
  stage: Konva.Stage,
  crop: Crop,
  kind: SequenceKind,
  opts: SequenceOpts,
): Promise<void> {
  return kind === 'gif' ? exportGif(stage, crop, opts) : exportWebm(stage, crop, opts)
}

async function exportGif(
  stage: Konva.Stage,
  crop: Crop,
  { frameCount, speed }: SequenceOpts,
  filename = 'footyboard.gif',
): Promise<void> {
  if (frameCount < 2)
    throw new AppError('A GIF needs at least two frames. Capture another position with + Frame, then export.')
  const geom = frameGeometry(crop, GIF_MAX_WIDTH)
  const { width: w, height: h } = geom
  const { ctx } = makeCanvas(geom, true)

  const steps = gifSteps(frameCount, speed)
  const delay = gifDelay(frameCount, speed, steps)

  const gif = GIFEncoder()
  const restore = useBoardStore.getState().playback.position
  const at = (i: number) => (i / steps) * (frameCount - 1)

  try {
    /**
     * The palette pass, before anything is written.
     *
     * The samples are concatenated and quantised together, so the one table has
     * an entry near every colour the sequence shows rather than near only the
     * colours standing still at the start. `getImageData` returns a fresh buffer
     * each call, so these are copies and not four views of the same pixels.
     */
    const sampleSteps = paletteSampleSteps(steps)
    const pixels = new Uint8Array(sampleSteps.length * w * h * 4)
    for (let s = 0; s < sampleSteps.length; s++) {
      await paintFrame(stage, crop, at(sampleSteps[s]), ctx, geom)
      pixels.set(ctx.getImageData(0, 0, w, h).data, s * w * h * 4)
    }
    const palette = quantize(pixels, 256)

    for (let i = 0; i <= steps; i++) {
      // Awaiting here is what makes each frame distinct — see paintFrame.
      await paintFrame(stage, crop, at(i), ctx, geom)
      const { data } = ctx.getImageData(0, 0, w, h)
      const index = applyPalette(data, palette)
      /**
       * Only the first frame carries the palette, and every frame is indexed
       * against that same one. The first becomes the global colour table; every
       * later frame written without a palette is decoded against it, which is
       * exactly what is wanted and is what the interval version got wrong. It
       * also keeps the 33 KB of duplicate local colour tables out of the file,
       * but that is the side benefit rather than the reason.
       */
      gif.writeFrame(index, w, h, { palette: i === 0 ? palette : undefined, delay })
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

async function exportWebm(
  stage: Konva.Stage,
  crop: Crop,
  { frameCount, speed }: SequenceOpts,
  filename = 'footyboard.webm',
): Promise<void> {
  if (frameCount < 2)
    throw new AppError('A video needs at least two frames. Capture another position with + Frame, then export.')
  const mimeType = pickMime()
  if (!mimeType)
    throw new AppError("This browser can't record video. Export a GIF instead, or try Chrome or Edge.")

  const geom = frameGeometry(crop, VIDEO_MAX_WIDTH, VIDEO_SCALE)
  const { canvas, ctx } = makeCanvas(geom)

  const stream = canvas.captureStream(WEBM_FPS)
  const chunks: BlobPart[] = []
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate(geom) })
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const durationMs = (sequenceDuration(frameCount, SECONDS_PER_FRAME) / speed) * 1000
  const restore = useBoardStore.getState().playback.position
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
  const outName = filename.replace(/\.\w+$/, `.${ext}`)

  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve()
  })

  rec.start()
  const start = performance.now()
  try {
    // Walk the sequence in real time, awaiting each paint so the recorder gets
    // the frame it is being shown rather than the one before it.
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / durationMs)
      await paintFrame(stage, crop, t * (frameCount - 1), ctx, geom)
      if (t >= 1) break
    }
  } finally {
    // Three things have to come back whether or not the walk finished, and only
    // one of them was ever conditional on failure.
    //
    // `MediaRecorder.stop()` does not stop the tracks feeding it, so the
    // capture stream kept pulling frames off the canvas for the life of the
    // page after *every* export, the successful ones included.
    //
    // The other two are the failure path: a paint that throws (`toCanvas`
    // raising, or the stage going away because the board was navigated off)
    // used to leave the recorder in `recording` for good and the board frozen
    // at whatever position the export had scrubbed to, with nothing saying why.
    if (rec.state !== 'inactive') rec.stop()
    for (const track of stream.getTracks()) track.stop()
    useBoardStore.getState().setPlayback({ position: restore })
  }
  // Downloading only after the loop completed, rather than from `onstop`: the
  // teardown above stops the recorder on the failure path too, and handing
  // somebody a truncated video of an export that just failed is worse than
  // handing them nothing.
  await done
  download(new Blob(chunks, { type: mimeType }), outName)
}
