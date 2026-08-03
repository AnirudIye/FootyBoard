import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Konva from 'konva'
import {
  exportSequence,
  frameGeometry,
  gifBudget,
  gifSteps,
  paletteSampleSteps,
  videoBitrate, gifDelay } from './exportSequence'
import { useBoardStore } from '../../store/boardStore'

/**
 * The GIF path is exercised against a stubbed encoder.
 *
 * What is worth asserting about it is which frames compute a palette and which
 * frames carry one into the file — a policy, not an image — and jsdom has no
 * canvas to produce pixels for a real encoder to read anyway. Stubbing the
 * three functions this module calls says exactly that, and nothing about
 * gifenc's own behaviour, which is not this file's to test.
 */
const written: { width: number; height: number; palette: number[][] | null }[] = []
const quantized: number[] = []
/** The palette each frame's pixels were actually mapped against. */
const indexedWith: (number[][] | null)[] = []

vi.mock('gifenc', () => ({
  GIFEncoder: () => ({
    writeFrame: (
      _index: Uint8Array,
      width: number,
      height: number,
      opts: { palette?: number[][] },
    ) => written.push({ width, height, palette: opts.palette ?? null }),
    finish: () => {},
    bytes: () => new Uint8Array([0x47, 0x49, 0x46]),
  }),
  // A different table per call, so a test can tell one from another. That is
  // the whole point: the bug this file now guards was two palettes in one GIF.
  quantize: (data: Uint8ClampedArray) => {
    quantized.push(data.length)
    return [[quantized.length, 0, 0]]
  },
  applyPalette: (_data: Uint8ClampedArray, palette: number[][]) => {
    indexedWith.push(palette)
    return new Uint8Array(0)
  },
}))

/**
 * What a video export has to leave behind, and it is the same list either way.
 *
 * A `MediaRecorder` stopping is not the same thing as the stream feeding it
 * stopping: `stop()` finalises the recording and leaves every track of the
 * `canvas.captureStream()` live, pulling frames off a canvas nobody is drawing
 * to for the rest of the page's life. That leaked on the *successful* path, on
 * every export.
 *
 * The failure path leaked more. The walk was not wrapped at all, so a paint
 * that threw (`toCanvas` raising, or the stage going away because the board was
 * navigated off) skipped `rec.stop()` and skipped the playhead restore.
 * The recorder stayed in `recording` for good and the board stayed frozen at
 * whatever position the export had scrubbed to, with nothing saying why.
 *
 * jsdom has no canvas, no capture stream and no MediaRecorder, so all three are
 * stood in for here. That is fine for this: what is being asserted is the
 * teardown this module performs, not what a browser does with it.
 */

const CROP = { x: 0, y: 0, width: 320, height: 200 }

let recorders: FakeRecorder[] = []
let streams: FakeStream[] = []
let downloaded: string[] = []

class FakeTrack {
  stopped = false
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()]
  readonly size: { w: number; h: number }
  constructor(size: { w: number; h: number }) {
    this.size = size
  }
  getTracks() {
    return this.tracks
  }
}

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'video/webm;codecs=vp9'
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  readonly options: MediaRecorderOptions

  constructor(_stream: unknown, options: MediaRecorderOptions = {}) {
    this.options = options
    recorders.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    // The real one throws InvalidStateError when it is already inactive, which
    // is why the teardown checks before calling.
    if (this.state === 'inactive') throw new Error('InvalidStateError')
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['frame']) })
      this.onstop?.()
    })
  }
}

const fakeCtx = {
  fillStyle: '',
  font: '',
  textAlign: '',
  textBaseline: '',
  fillRect: () => {},
  drawImage: () => {},
  fillText: () => {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
}

type CanvasProto = { captureStream?: (fps?: number) => FakeStream }

const workingStage = () =>
  ({ draw: () => {}, toCanvas: () => document.createElement('canvas') }) as unknown as Konva.Stage

const brokenStage = (message: string) =>
  ({
    draw: () => {},
    toCanvas: () => {
      throw new Error(message)
    },
  }) as unknown as Konva.Stage

const track = () => streams[0].getTracks()[0]

let realCreateObjectURL: typeof URL.createObjectURL
let realRevokeObjectURL: typeof URL.revokeObjectURL

beforeEach(() => {
  recorders = []
  streams = []
  downloaded = []

  useBoardStore.getState().initDefaultBoard()
  useBoardStore.getState().addFrame()
  useBoardStore.getState().addFrame()
  useBoardStore.getState().setPlayback({ position: 1 })

  written.length = 0
  quantized.length = 0
  indexedWith.length = 0

  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as never)
  // A plain function rather than an arrow: the canvas it is called on is what
  // says how big the recording is, which is half of what these tests check.
  ;(HTMLCanvasElement.prototype as unknown as CanvasProto).captureStream = function (
    this: HTMLCanvasElement,
  ) {
    const stream = new FakeStream({ w: this.width, h: this.height })
    streams.push(stream)
    return stream
  }

  realCreateObjectURL = URL.createObjectURL
  realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:footyboard-test'
  URL.revokeObjectURL = () => {}
  // jsdom treats a real anchor click as a navigation it has not implemented,
  // which is noise rather than a result. The download attribute is the part
  // worth reading anyway.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.push(this.download)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLCanvasElement.prototype as unknown as CanvasProto).captureStream
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

describe('WebM export teardown', () => {
  it('leaves no recorder recording when a paint throws', async () => {
    await expect(
      exportSequence(brokenStage('the stage is gone'), CROP, 'webm', { frameCount: 2, speed: 1 }),
    ).rejects.toThrow('the stage is gone')

    // It really did get as far as recording, or none of the below proves
    // anything.
    expect(recorders).toHaveLength(1)
    expect(recorders[0].state).toBe('inactive')
    expect(track().stopped).toBe(true)
  })

  it('puts the playhead back where the user left it when a paint throws', async () => {
    // The export scrubs the board as it walks. Frame 0 is where the first paint
    // sends it, and the throw comes after that, so an unguarded walk strands the
    // board there with nothing to say why.
    await expect(
      exportSequence(brokenStage('the stage is gone'), CROP, 'webm', { frameCount: 2, speed: 1 }),
    ).rejects.toThrow('the stage is gone')

    expect(useBoardStore.getState().playback.position).toBe(1)
  })

  it('hands nobody a truncated file for an export that failed', async () => {
    await expect(
      exportSequence(brokenStage('the stage is gone'), CROP, 'webm', { frameCount: 2, speed: 1 }),
    ).rejects.toThrow('the stage is gone')

    expect(downloaded).toEqual([])
  })

  it('stops the capture stream on the successful path too', async () => {
    // Sped up so the real-time walk is a few milliseconds rather than 1.1s.
    await exportSequence(workingStage(), CROP, 'webm', { frameCount: 2, speed: 200 })

    expect(recorders[0].state).toBe('inactive')
    expect(track().stopped).toBe(true)
    expect(useBoardStore.getState().playback.position).toBe(1)
  })

  it('still produces the file', async () => {
    await exportSequence(workingStage(), CROP, 'webm', { frameCount: 2, speed: 200 })
    expect(downloaded).toEqual(['footyboard.webm'])
  })
})

/**
 * What each format asks for, now that they no longer share one width.
 *
 * Both used to be capped at 640 and rendered at the board's on-screen size,
 * which made the video soft — a wide pitch was shrunk to 640 and then stretched
 * back out by whoever watched it — and made the GIF pay for a full-size render
 * it immediately threw most of away.
 */
describe('frame geometry', () => {
  it('holds the width under the cap and keeps both axes even', () => {
    // Odd on both axes on purpose: encoders want even, and both have to be
    // rounded rather than only the one being capped.
    const g = frameGeometry({ x: 0, y: 0, width: 1047, height: 677 }, 640)
    expect(g.width).toBe(640)
    expect(g.width % 2).toBe(0)
    expect(g.height % 2).toBe(0)
    expect(g.height).toBeLessThan(g.width)
  })

  it('leaves a board smaller than the cap alone when it is not asked to scale', () => {
    const g = frameGeometry({ x: 0, y: 0, width: 300, height: 200 }, 640)
    expect(g).toEqual({ width: 300, height: 200, pixelRatio: 1 })
  })

  it('renders a small board larger when it is asked to scale, and stops at the cap', () => {
    const small = frameGeometry({ x: 0, y: 0, width: 400, height: 260 }, 1280, 2)
    expect(small.width).toBe(800)

    const wide = frameGeometry({ x: 0, y: 0, width: 1048, height: 678 }, 1280, 2)
    expect(wide.width).toBe(1280)
  })

  it('reports the pixel ratio that makes the board render at the output width', () => {
    // This is the number that replaced a hard-coded 1. Multiplied back by the
    // crop it has to land on the output width, or Konva draws at one size and
    // the frame is stretched to another.
    const crop = { x: 0, y: 0, width: 1048, height: 678 }
    const g = frameGeometry(crop, 640)
    expect(crop.width * g.pixelRatio).toBeCloseTo(g.width, 6)
  })

  it('survives a crop with no width', () => {
    // Dividing by it is how the output size is found, and a board measured
    // before layout has settled is zero wide.
    const g = frameGeometry({ x: 0, y: 0, width: 0, height: 0 }, 640, 2)
    expect(g).toEqual({ width: 2, height: 2, pixelRatio: 1 })
    expect(Number.isFinite(g.pixelRatio)).toBe(true)
  })
})

describe('GIF frame and palette policy', () => {
  it('writes both ends of the sequence at twenty a second', () => {
    // Two seconds and a fifth of movement, so 44 steps and 45 frames: the walk
    // includes the position it starts from as well as the one it ends on.
    expect(gifSteps(3, 1)).toBe(44)
    expect(gifSteps(3, 2)).toBe(22)
  })

  it('never writes a single-frame GIF however fast the playback', () => {
    expect(gifSteps(2, 1000)).toBe(2)
  })

  it('samples both ends of the walk and evenly between them', () => {
    expect(paletteSampleSteps(44)).toEqual([0, 15, 29, 44])
    // Never more samples than there are frames, and never a duplicate.
    expect(paletteSampleSteps(2)).toEqual([0, 1, 2])
    expect(paletteSampleSteps(0)).toEqual([0])
  })

  it('quantises once for the whole GIF, not once a frame', async () => {
    await exportSequence(workingStage(), CROP, 'gif', { frameCount: 3, speed: 1 })

    expect(written).toHaveLength(45)
    expect(quantized).toHaveLength(1)
    // ...over the four sampled frames at once, which is what makes one table
    // enough for a sequence whose colours arrive late.
    expect(quantized[0]).toBe(4 * CROP.width * CROP.height * 4)
  })

  /**
   * The one that matters, and the one whose absence shipped a broken GIF.
   *
   * gifenc decodes any frame written *without* a palette against the **global**
   * colour table — the first frame's — and not against whichever local table
   * came before it. So indexing a frame against a palette the file does not
   * carry at that point is not a smaller file, it is the wrong colours: the
   * shipped version refreshed every twentieth frame and left nineteen frames in
   * twenty indexed against a table the decoder never used. On screen the pitch
   * lines went red and the home shirts went grey.
   *
   * The test that stood here asserted the palettes landed on frames 0, 20 and
   * 40 — which is what the code did, and not what a decoder does. Asserting that
   * every frame is indexed against the table the file actually carries is the
   * check that would have caught it.
   */
  it('indexes every frame against the one table the file carries', async () => {
    await exportSequence(workingStage(), CROP, 'gif', { frameCount: 3, speed: 1 })

    const global = written[0].palette
    expect(global).not.toBeNull()
    // No frame but the first carries a table of its own...
    expect(written.slice(1).every((f) => f.palette === null)).toBe(true)
    // ...and every frame's pixels were mapped against that same global one.
    expect(indexedWith).toHaveLength(45)
    expect(indexedWith.every((p) => p === global)).toBe(true)
  })

  it('does not enlarge the board for a GIF, the way it does for a video', async () => {
    await exportSequence(workingStage(), CROP, 'gif', { frameCount: 3, speed: 1 })
    expect(written[0]).toMatchObject({ width: CROP.width, height: CROP.height })

    await exportSequence(workingStage(), CROP, 'webm', { frameCount: 2, speed: 200 })
    expect(streams[0].size).toEqual({ w: CROP.width * 2, h: CROP.height * 2 })
  })
})

describe('video quality', () => {
  it('records at twice the board rather than at the width a GIF wants', async () => {
    await exportSequence(workingStage(), CROP, 'webm', { frameCount: 2, speed: 200 })
    expect(streams[0].size).toEqual({ w: 640, h: 400 })
  })

  it('hands the recorder a ceiling of its own rather than taking the default', async () => {
    // Unset, the ceiling is whatever the browser picks, and a browser that
    // picks a flat number picks it without knowing the frame just quadrupled.
    await exportSequence(workingStage(), CROP, 'webm', { frameCount: 2, speed: 200 })

    expect(recorders[0].options.videoBitsPerSecond).toBe(videoBitrate(frameGeometry(CROP, 1280, 2)))
    expect(recorders[0].options.videoBitsPerSecond).toBeGreaterThan(1_000_000)
  })
})

/**
 * The cap, and the delay that has to move with it.
 *
 * Every other change here made a frame cheaper; this is the only one that
 * bounds how many there are, and it is the one that answers a long storyboard.
 */
describe('a GIF is bounded however long the sequence is', () => {
  it('leaves a short sequence exactly as it was', () => {
    // Three captured frames is 2.2s, which is 44 steps at 20fps: under the cap,
    // so the cap must not be visible at all here.
    expect(gifSteps(3, 1)).toBe(44)
  })

  it('caps a long one rather than letting the cost run with the length', () => {
    // Twelve frames is 242 steps uncapped, twenty is 418.
    expect(gifSteps(12, 1)).toBe(150)
    expect(gifSteps(20, 1)).toBe(150)
  })

  it('keeps a capped GIF the length of the sequence it pictures', () => {
    // The whole point of deriving the delay: 20 frames is 20.9s of storyboard,
    // and it has to still take 20.9s once it is only 150 frames long.
    const steps = gifSteps(20, 1)
    const totalMs = gifDelay(20, 1, steps) * steps
    expect(totalMs / 1000).toBeCloseTo(20.9, 0)
  })

  it('still runs at 20fps when nothing was capped', () => {
    const steps = gifSteps(3, 1)
    expect(gifDelay(3, 1, steps)).toBe(50)
  })

  it('honours the speed control on both', () => {
    // Double speed halves the seconds, so it halves the steps too...
    expect(gifSteps(3, 2)).toBe(22)
    // ...and the delay stays at the frame rate rather than doubling.
    expect(gifDelay(3, 2, gifSteps(3, 2))).toBe(50)
  })
})

/**
 * The second budget, and what it is for.
 *
 * Every written frame is a React commit, a Konva draw, a `getImageData`, a
 * palette mapping and an LZW pass, all of them on the main thread. At 20fps and
 * 150 frames a twelve-frame storyboard measured **40.5 seconds with 85% of it
 * blocked** in a Chromium at 375x812 under 6x CPU throttling — which is not a
 * slow export, it is a page nobody can touch. A finger gets a quarter of that
 * work, and pays for it in smoothness rather than in time.
 */
describe('what a phone may spend on a GIF', () => {
  it('writes fewer frames a second under a finger', () => {
    // 2.2 seconds of movement: 44 steps at 20fps, 26 at 12.
    expect(gifSteps(3, 1, gifBudget(false))).toBe(44)
    expect(gifSteps(3, 1, gifBudget(true))).toBe(26)
  })

  it('caps a long sequence far sooner', () => {
    expect(gifSteps(12, 1, gifBudget(false))).toBe(150)
    expect(gifSteps(12, 1, gifBudget(true))).toBe(60)
    // And a longer one costs no more than that, which is the whole point of a
    // cap: the worst case is bounded rather than linear in the storyboard.
    expect(gifSteps(20, 1, gifBudget(true))).toBe(60)
  })

  it('still plays back the length of the sequence it pictures', () => {
    // The cap must cost frame rate and never duration — a phone handing back a
    // five-second GIF of a twelve-second move is a worse bug than a slow one.
    const steps = gifSteps(12, 1, gifBudget(true))
    expect((gifDelay(12, 1, steps) * steps) / 1000).toBeCloseTo(12.1, 0)
  })

  it('takes the mouse budget on a machine with no matchMedia at all', () => {
    // Which is jsdom, and is also every server-rendered pass. Guessing "phone"
    // where the question cannot be asked would quietly halve every desktop GIF.
    expect(gifBudget()).toEqual({ fps: 20, maxFrames: 150 })
  })

  it('takes the finger budget when the pointer is coarse', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
    }))
    expect(gifBudget()).toEqual({ fps: 12, maxFrames: 60 })
  })

  it('writes the shorter walk end to end, not merely in the arithmetic', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
    }))
    await exportSequence(workingStage(), CROP, 'gif', { frameCount: 3, speed: 1 })
    // 27 rather than the 45 the same sequence writes under a mouse.
    expect(written).toHaveLength(27)
  })
})

/**
 * Progress, and why it is reported coarsely.
 *
 * A phone export runs for seconds, so it owes the person holding it evidence
 * that it is moving. What it must not do is buy that evidence with the thing it
 * was made cheap to protect: `onProgress` drives React state, and firing once
 * per written frame would hand back exactly the renders that freezing the frame
 * strip's playhead removed — a third of a phone export, measured.
 */
describe('progress', () => {
  const track = async (kind: 'gif' | 'webm', opts: { frameCount: number; speed: number }) => {
    const seen: number[] = []
    await exportSequence(workingStage(), CROP, kind, { ...opts, onProgress: (f) => seen.push(f) })
    return seen
  }

  it('starts at nothing and ends at done', async () => {
    const seen = await track('gif', { frameCount: 3, speed: 1 })
    expect(seen[0]).toBe(0)
    expect(seen.at(-1)).toBe(1)
  })

  it('never goes backwards', async () => {
    const seen = await track('gif', { frameCount: 3, speed: 1 })
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  it('costs a handful of renders rather than one per frame', async () => {
    const seen = await track('gif', { frameCount: 3, speed: 1 })
    expect(written).toHaveLength(45)
    // Twenty five-percent steps, plus the two ends.
    expect(seen.length).toBeLessThanOrEqual(22)
  })

  it('reports on a video too, where the walk is the clock', async () => {
    const seen = await track('webm', { frameCount: 2, speed: 200 })
    expect(seen[0]).toBe(0)
    expect(seen.at(-1)).toBe(1)
  })
})
