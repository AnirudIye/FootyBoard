import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Rect } from 'react-konva'
import type Konva from 'konva'
import { useBoardStore } from '../../store/boardStore'
import { computeMapping } from './pitchMapping'
import { PitchMappingContext } from './pitchContext'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useAnimatedMapping } from '../../hooks/useAnimatedMapping'
import { useDrawGesture } from '../../hooks/useDrawGesture'
import PitchLayer from './PitchLayer'
import TokenLayer from './TokenLayer'
import DrawingLayer from './DrawingLayer'
import PeerLayer from './PeerLayer'
import { sendCursor } from '../../hooks/useRealtime'
import { useRealtimeStore } from '../../store/realtimeStore'
import DrawingShape from './DrawingShape'
import { boardHandles } from './boardHandles'
import { exportBoardPng } from '../../lib/export'
import { AppError } from '../../lib/errors'
import { exportSequenceGif, exportSequenceWebm } from './exportSequence'
import type { Crop } from './exportSequence'

interface Marquee {
  x1: number
  y1: number
  x2: number
  y2: number
  additive: boolean
}

export default function PitchCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [marquee, setMarquee] = useState<Marquee | null>(null)

  const view = useBoardStore((s) => s.view)
  const clearSelection = useBoardStore((s) => s.clearSelection)
  const setSelection = useBoardStore((s) => s.setSelection)
  const setZoom = useBoardStore((s) => s.setZoom)
  const pz = usePanZoom()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const target = useMemo(
    () => computeMapping(view.view, view.kind, size.w || 1, size.h || 1),
    [view.view, view.kind, size.w, size.h],
  )
  const mapping = useAnimatedMapping(target)

  // The board is read-only while the owner has the floor. The server enforces
  // this regardless; the interface follows so it does not offer what will not
  // work.
  const locked = useRealtimeStore((s) => s.locked)

  const relPointer = () => stageRef.current?.getRelativePointerPosition() ?? null
  const pointerNorm = () => {
    const p = relPointer()
    return p ? mapping.toNorm(p.x, p.y) : null
  }
  const draw = useDrawGesture(pointerNorm)

  const { fitPitch } = pz
  useEffect(() => {
    fitPitch()
  }, [view.view, view.kind, fitPitch])

  useEffect(() => {
    setZoom(pz.scale)
  }, [pz.scale, setZoom])

  useEffect(() => {
    const cropNow = (): Crop => {
      const b = mapping.box
      return {
        x: b.x * pz.scale + pz.position.x,
        y: b.y * pz.scale + pz.position.y,
        width: b.w * pz.scale,
        height: b.h * pz.scale,
      }
    }
    boardHandles.fitPitch = fitPitch
    boardHandles.exportPng = async (filename) => {
      const stage = stageRef.current
      if (!stage) throw new AppError('The board is still loading. Give it a moment, then try again.')
      useBoardStore.getState().clearSelection()
      await exportBoardPng(stage, cropNow(), filename)
    }
    boardHandles.exportGif = async () => {
      const stage = stageRef.current
      if (!stage) throw new AppError('The board is still loading. Give it a moment, then try again.')
      const st = useBoardStore.getState()
      st.clearSelection()
      await exportSequenceGif(stage, cropNow(), {
        frameCount: st.frames.length,
        speed: st.playback.speed,
      })
    }
    boardHandles.exportWebm = async () => {
      const stage = stageRef.current
      if (!stage) throw new AppError('The board is still loading. Give it a moment, then try again.')
      const st = useBoardStore.getState()
      st.clearSelection()
      await exportSequenceWebm(stage, cropNow(), {
        frameCount: st.frames.length,
        speed: st.playback.speed,
      })
    }
    if (import.meta.env.DEV) {
      ;(window as unknown as { __boardHandles?: typeof boardHandles }).__boardHandles = boardHandles
    }
    return () => {
      boardHandles.fitPitch = null
      boardHandles.exportPng = null
      boardHandles.exportGif = null
      boardHandles.exportWebm = null
    }
  }, [mapping, pz.scale, pz.position, fitPitch])

  const finishMarquee = (m: Marquee) => {
    const left = Math.min(m.x1, m.x2)
    const right = Math.max(m.x1, m.x2)
    const top = Math.min(m.y1, m.y2)
    const bottom = Math.max(m.y1, m.y2)
    if (right - left < 3 && bottom - top < 3) return

    const { tokens, selection } = useBoardStore.getState()
    const hit = tokens
      .filter((t) => {
        const p = mapping.toPx(t.x, t.y)
        return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
      })
      .map((t) => t.id)
    setSelection(m.additive ? Array.from(new Set([...selection, ...hit])) : hit)
  }

  const ready = size.w > 0 && size.h > 0
  const cursor = pz.panning ? 'grabbing' : draw.drawing ? 'crosshair' : 'default'

  return (
    <PitchMappingContext.Provider value={mapping}>
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        style={{ cursor }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {ready && (
          <Stage
            ref={stageRef}
            width={size.w}
            height={size.h}
            scaleX={pz.scale}
            scaleY={pz.scale}
            x={pz.position.x}
            y={pz.position.y}
            onWheel={pz.onWheel}
            onDblClick={() => {
              if (locked) return
              draw.commitPoly()
            }}
            onPointerDown={(e) => {
              pz.onPointerDown(e)
              const panning = pz.spaceHeldRef.current || e.evt.button === 1
              if (panning || e.evt.button !== 0) return
              // Locked: panning, zooming and selecting stay available, because
              // watching a session is not a passive activity — you still want to
              // look where you like. Only drawing is withheld.
              if (!locked && draw.onPointerDown(e.evt.clientX, e.evt.clientY)) return
              if (e.target !== e.target.getStage()) return
              const p = relPointer()
              if (!p) return
              if (!e.evt.shiftKey) clearSelection()
              setMarquee({ x1: p.x, y1: p.y, x2: p.x, y2: p.y, additive: e.evt.shiftKey })
            }}
            onPointerMove={(e) => {
              pz.onPointerMove(e)
              // Before any early return: peers should see the pointer whatever
              // it is doing, including drawing and dragging.
              const n = pointerNorm()
              if (n) sendCursor(n.x, n.y)
              if (!locked && draw.onPointerMove()) return
              if (!marquee) return
              const p = relPointer()
              if (!p) return
              setMarquee({ ...marquee, x2: p.x, y2: p.y })
            }}
            onPointerUp={() => {
              pz.onPointerUp()
              if (!locked && draw.onPointerUp()) return
              if (marquee) {
                finishMarquee(marquee)
                setMarquee(null)
              }
            }}
          >
            <Layer listening={false}>
              <PitchLayer mapping={mapping} />
            </Layer>
            {/* One switch rather than a `draggable` prop on every token and
                shape: while locked, nothing on the board responds to a pointer,
                so there is no drag to start and no inspector to open. */}
            <Layer listening={!locked}>
              <DrawingLayer mapping={mapping} kind="zones" />
            </Layer>
            <Layer listening={!locked}>
              <TokenLayer mapping={mapping} />
            </Layer>
            <Layer listening={!locked}>
              <DrawingLayer mapping={mapping} kind="marks" />
              <DrawingLayer mapping={mapping} kind="text" />
            </Layer>
            <Layer listening={false}>
              <PeerLayer mapping={mapping} />
              {draw.preview && (
                <DrawingShape drawing={draw.preview} mapping={mapping} selected={false} />
              )}
              {marquee && (
                <Rect
                  x={Math.min(marquee.x1, marquee.x2)}
                  y={Math.min(marquee.y1, marquee.y2)}
                  width={Math.abs(marquee.x2 - marquee.x1)}
                  height={Math.abs(marquee.y2 - marquee.y1)}
                  fill="rgba(244,242,239,0.08)"
                  stroke="#f4f2ef"
                  strokeWidth={1}
                  dash={[4, 3]}
                  opacity={0.7}
                />
              )}
            </Layer>
          </Stage>
        )}

        {draw.textDraft && (
          <input
            autoFocus
            placeholder="Type a label, then Enter"
            style={{ left: draw.textDraft.screenX, top: draw.textDraft.screenY }}
            onBlur={(e) => draw.commitText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') draw.commitText(e.currentTarget.value)
              if (e.key === 'Escape') draw.cancel()
            }}
            className="fixed z-30 w-52 rounded border border-rule bg-surface px-2 py-1 text-[13px]
              shadow-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        )}
      </div>
    </PitchMappingContext.Provider>
  )
}
