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

// A video is cheap enough to run at screen rate: the recorder encodes it, the
// walk is real time, and a frame costs a paint and nothing else. A GIF's frames
// are each paid for on this thread, which is why its rate is a budget below
// rather than a constant here.
const WEBM_FPS = 30

/** What one device may spend writing a GIF. */
export interface GifBudget {
  /** Frames written per second of sequence. */
  fps: number
  /** The most frames written, however long the sequence is. */
  maxFrames: number
}

/**
 * Two budgets, because a phone is not a slower desktop — it is a different
 * order of machine, and one constant could only ever be right for one of them.
 *
 * **Every GIF frame is a React commit, a Konva draw, a `getImageData`, a
 * palette mapping and an LZW pass, and all five are on the main thread.** The
 * work per frame is roughly fixed by the board rather than by the screen: a
 * phone's pitch is a third of the pixels, but the commit that dominates is the
 * same tree either way, so a small screen buys far less than it looks like it
 * should.
 *
 * Measured against `npm run dev` in a Chromium at 375x812 under CPU throttling,
 * which is the closest thing here to a real handset — 4x for a mid-range phone,
 * 6x for a cheap or old one. Before this budget existed, at 20fps and 150
 * frames:
 *
 * ```
 * 3 captured frames,  4x CPU    45 written    6.4s   82% of it main-thread blocked
 * 6 captured frames,  4x CPU   111 written   15.3s   83% blocked
 * 12 captured frames, 6x CPU   150 written   40.5s   85% blocked, worst block 578ms
 * ```
 *
 * Forty seconds of a page that answers a tap once every quarter second is not a
 * slow export, it is a broken one, and nothing in the format degrades on its
 * own. So a finger gets 12fps and 60 frames: about a quarter of the work in the
 * worst case, and `gifDelay` keeps the GIF the length of the sequence it
 * pictures rather than playing it back short and fast.
 *
 * **What this costs is smoothness, and that is the right thing to spend.** A
 * tactics move is slow, near-linear travel between poses — it reads perfectly
 * at 12fps — and the file is the thing somebody has to send from a phone, where
 * the cap also takes a twelve-frame storyboard from 1.4 MB to about 570 KB. It
 * is the same trade `maxFrames` already made on a desktop for a long sequence,
 * made one step earlier for a machine that reaches the point sooner.
 *
 * The pointer is the signal, matching `useCoarsePointer` and the 44px floor in
 * `index.css`: it is the input device rather than the screen, so a tablet with
 * a trackpad is a desktop here and a 1280px tablet under a thumb is not. It
 * mis-sorts a touchscreen laptop into the cheaper budget, which costs that
 * machine some frame rate and nothing else — the failure the other way round is
 * the forty seconds above.
 */
const GIF_MOUSE: GifBudget = { fps: 20, maxFrames: 150 }
const GIF_FINGER: GifBudget = { fps: 12, maxFrames: 60 }

/** Whether a finger is driving this session. jsdom has no `matchMedia` at all. */
const coarsePointer = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches

/** The budget this device gets. Takes the answer directly so a test can set it. */
export const gifBudget = (coarse = coarsePointer()): GifBudget =>
  coarse ? GIF_FINGER : GIF_MOUSE

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

/**
 * How long a finished file's object URL is left alive after the click.
 *
 * It was revoked on the next line, which is the shape everybody writes and is a
 * race the whole time: `a.click()` only *starts* a download, and revoking the
 * URL destroys the blob the browser is still being asked to read from. Chromium
 * happens to take a reference synchronously, so it never showed up here — the
 * browsers that do not are Safari's, and iOS Safari is the one platform this
 * export has never been tried on.
 *
 * Left as a timeout rather than removed, because the alternative is a leak: a
 * revoked-nowhere blob holds its bytes for the life of the page, and a 2.5 MB
 * GIF exported a few times over a long session is real memory on a phone. A
 * minute is far longer than any browser needs to take its own reference and far
 * shorter than a session.
 */
const REVOKE_AFTER = 60_000

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER)
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
 * The last index of the GIF's walk. It writes `steps + 1` frames, because the
 * walk includes both ends of the sequence.
 *
 * `maxFrames` is the only thing bounding how many frames there are, and without
 * it the cost is simply linear in the length of the storyboard: at 20fps twelve
 * captured frames is 242 written ones, and each is a paint, a `getImageData`, a
 * palette mapping and an LZW pass. On a desktop that is seven seconds of blocked
 * main thread and a 4.1 MB file; a twenty-frame storyboard is twelve seconds and
 * 7 MB. Nothing in the format degrades gracefully on its own, so past the cap a
 * GIF loses frame rate rather than losing time — see `gifDelay`, which is what
 * keeps that true, and `GIF_MOUSE` for what the two budgets are.
 */
export function gifSteps(
  frameCount: number,
  speed: number,
  budget: GifBudget = gifBudget(),
): number {
  const seconds = sequenceDuration(frameCount, SECONDS_PER_FRAME) / speed
  return Math.max(2, Math.min(budget.maxFrames, Math.round(seconds * budget.fps)))
}

/**
 * Milliseconds to hold each written frame, derived from the walk rather than
 * from the budget's frame rate.
 *
 * The two agreed exactly while `steps` was `seconds * fps`, so a constant
 * `1000 / fps` was right by construction. The cap breaks that agreement:
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
  /**
   * How far along the export is, 0 to 1.
   *
   * Reported in coarse steps rather than per frame, and the throttle is the
   * point rather than a nicety: what this drives is React state, and a component
   * that re-rendered once per written frame would be spending on the strip
   * exactly the budget the frame cap was added to protect. Freezing the strip's
   * playhead while an export runs took a twelve-frame phone export from 40.5s to
   * 24.7s by removing 150 such renders; handing them straight back through the
   * progress bar would be an odd way to spend that.
   */
  onProgress?: (fraction: number) => void
}

/** How much has to change before the caller hears about it. See `onProgress`. */
const PROGRESS_STEP = 0.05

/** Wraps `onProgress` so it fires on movement worth a render, and on the ends. */
function throttleProgress(onProgress: SequenceOpts['onProgress']) {
  let last = -1
  return (fraction: number) => {
    if (!onProgress) return
    const f = Math.min(1, Math.max(0, fraction))
    if (f !== 1 && f - last < PROGRESS_STEP) return
    last = f
    onProgress(f)
  }
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
  { frameCount, speed, onProgress }: SequenceOpts,
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

  // The palette pass is paints too, so it counts towards the total. Leaving it
  // out would park the bar at zero for the first four frames of a short export,
  // which on a phone is a visible fraction of the whole thing.
  const sampleSteps = paletteSampleSteps(steps)
  const totalPaints = sampleSteps.length + steps + 1
  const report = throttleProgress(onProgress)
  let painted = 0
  const painting = () => report(++painted / totalPaints)
  report(0)

  try {
    /**
     * The palette pass, before anything is written.
     *
     * The samples are concatenated and quantised together, so the one table has
     * an entry near every colour the sequence shows rather than near only the
     * colours standing still at the start. `getImageData` returns a fresh buffer
     * each call, so these are copies and not four views of the same pixels.
     */
    const pixels = new Uint8Array(sampleSteps.length * w * h * 4)
    for (let s = 0; s < sampleSteps.length; s++) {
      await paintFrame(stage, crop, at(sampleSteps[s]), ctx, geom)
      pixels.set(ctx.getImageData(0, 0, w, h).data, s * w * h * 4)
      painting()
    }
    const palette = quantize(pixels, 256)

    for (let i = 0; i <= steps; i++) {
      // Awaiting here is what makes each frame distinct — see paintFrame.
      await paintFrame(stage, crop, at(i), ctx, geom)
      painting()
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
  { frameCount, speed, onProgress }: SequenceOpts,
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

  // A video's walk is real time, so how far through it is *is* the progress —
  // no counting needed, and the bar moves at a steady rate rather than at
  // whatever rate the machine manages to write frames.
  const report = throttleProgress(onProgress)
  report(0)

  rec.start()
  const start = performance.now()
  try {
    // Walk the sequence in real time, awaiting each paint so the recorder gets
    // the frame it is being shown rather than the one before it.
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / durationMs)
      await paintFrame(stage, crop, t * (frameCount - 1), ctx, geom)
      report(t)
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
