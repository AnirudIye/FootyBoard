import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Konva from 'konva'
import { exportSequence } from './exportSequence'
import { useBoardStore } from '../../store/boardStore'

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
  getTracks() {
    return this.tracks
  }
}

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'video/webm;codecs=vp9'
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor() {
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

  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as never)
  ;(HTMLCanvasElement.prototype as unknown as CanvasProto).captureStream = () => {
    const stream = new FakeStream()
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
