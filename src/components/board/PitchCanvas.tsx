import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Rect } from 'react-konva'
import type Konva from 'konva'
import { useBoardStore } from '../../store/boardStore'
import { computeMapping } from './pitchMapping'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useAnimatedMapping } from '../../hooks/useAnimatedMapping'
import { useDrawGesture } from '../../hooks/useDrawGesture'
import { useWindowPointerUp } from '../../hooks/useWindowPointerUp'
import { isZone, isText, isMark } from '../../lib/drawings'
import PitchLayer from './PitchLayer'
import TokenLayer, { onScreen, lastDrawn } from './TokenLayer'
import DrawingLayer from './DrawingLayer'
import PeerLayer from './PeerLayer'
import { sendCursor } from '../../hooks/useRealtime'
import { useRealtimeStore } from '../../store/realtimeStore'
import DrawingShape from './DrawingShape'
import { boardHandles } from './boardHandles'
import { exportBoardPng } from '../../lib/export'
import { AppError } from '../../lib/errors'
import { exportSequence } from './exportSequence'
import type { Crop, SequenceKind } from './exportSequence'

interface Marquee {
  x: number
  y: number
  w: number
  h: number
  additive: boolean
}

export default function PitchCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // The corner the marquee was started from. The rectangle itself is kept the
  // way it will be read, so nothing downstream has to normalise it again.
  const marqueeFrom = useRef({ x: 0, y: 0 })
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
    const requireStage = (): Konva.Stage => {
      const stage = stageRef.current
      if (!stage) throw new AppError('The board is still loading. Give it a moment, then try again.')
      return stage
    }
    boardHandles.fitPitch = fitPitch
    boardHandles.exportPng = async () => {
      const stage = requireStage()
      useBoardStore.getState().clearSelection()
      await exportBoardPng(stage, cropNow())
    }
    boardHandles.exportSequence = async (kind: SequenceKind) => {
      const stage = requireStage()
      const st = useBoardStore.getState()
      st.clearSelection()
      await exportSequence(stage, cropNow(), kind, {
        frameCount: st.frames.length,
        speed: st.playback.speed,
      })
    }
    return () => {
      boardHandles.fitPitch = null
      boardHandles.exportPng = null
      boardHandles.exportSequence = null
    }
  }, [mapping, pz.scale, pz.position, fitPitch])

  const finishMarquee = (m: Marquee) => {
    if (m.w < 3 && m.h < 3) return

    const { tokens, selection } = useBoardStore.getState()
    const hit = tokens
      .filter((t) => {
        /**
         * Test what is on screen, not what is stored.
         *
         * A half view hides the off-half players entirely and pins the ball and
         * props to the edge, so a marquee working off raw stored positions caught
         * players nobody could see and missed props at the edge it had itself put
         * there. That much was already fixed.
         *
         * What was not: "on screen" meant the stored coordinate, and during
         * playback or a formation glide a chip is drawn somewhere else entirely.
         * So this reads the positions the layer actually drew, through the same
         * function the layer decides visibility with. Two answers that have to
         * agree is what this was before.
         */
        const { hidden, nx, ny } = onScreen(view.view, t, lastDrawn.positions)
        if (hidden) return false
        const p = mapping.toPx(nx, ny)
        return p.x >= m.x && p.x <= m.x + m.w && p.y >= m.y && p.y <= m.y + m.h
      })
      .map((t) => t.id)
    setSelection(m.additive ? Array.from(new Set([...selection, ...hit])) : hit)
  }

  // The one place a gesture ends, listened for on the window rather than on the
  // stage. See `useWindowPointerUp` for why the stage cannot see a release over
  // a bench rail, the toolbar or the frame strip. A release over the canvas
  // bubbles to the window too, so this is the whole of it and the stage carries
  // no `onPointerUp` of its own: two handlers would commit one drawing twice,
  // since React has not re-rendered between them and both would still be
  // holding the same draft.
  useWindowPointerUp(() => {
    pz.onPointerUp()
    if (!locked && draw.onPointerUp()) return
    if (marquee) {
      finishMarquee(marquee)
      setMarquee(null)
    }
  })

  const ready = size.w > 0 && size.h > 0
  const cursor = pz.panning ? 'grabbing' : draw.drawing ? 'crosshair' : 'default'

  return (
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
            marqueeFrom.current = { x: p.x, y: p.y }
            setMarquee({ x: p.x, y: p.y, w: 0, h: 0, additive: e.evt.shiftKey })
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
            const from = marqueeFrom.current
            setMarquee({
              ...marquee,
              x: Math.min(from.x, p.x),
              y: Math.min(from.y, p.y),
              w: Math.abs(p.x - from.x),
              h: Math.abs(p.y - from.y),
            })
          }}
        >
          <Layer listening={false}>
            <PitchLayer mapping={mapping} />
          </Layer>
          {/* One switch rather than a `draggable` prop on every token and
              shape: while locked, nothing on the board responds to a pointer,
              so there is no drag to start and no inspector to open. */}
          <Layer listening={!locked}>
            <DrawingLayer mapping={mapping} test={isZone} />
          </Layer>
          <Layer listening={!locked}>
            <TokenLayer mapping={mapping} />
          </Layer>
          <Layer listening={!locked}>
            <DrawingLayer mapping={mapping} test={isMark} />
            <DrawingLayer mapping={mapping} test={isText} />
          </Layer>
          <Layer listening={false}>
            <PeerLayer mapping={mapping} />
            {draw.preview && (
              <DrawingShape drawing={draw.preview} mapping={mapping} selected={false} />
            )}
            {marquee && (
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
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
  )
}
