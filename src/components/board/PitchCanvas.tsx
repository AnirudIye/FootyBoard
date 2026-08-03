import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Rect, Group, Ellipse } from 'react-konva'
import type Konva from 'konva'
import { useBoardStore } from '../../store/boardStore'
import { computeMapping, boardPerPixel } from './pitchMapping'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useAnimatedMapping } from '../../hooks/useAnimatedMapping'
import { useCoarsePointer } from '../../hooks/useCoarsePointer'
import { useDrawGesture } from '../../hooks/useDrawGesture'
import { useWindowPointerUp } from '../../hooks/useWindowPointerUp'
import { isZone, isText, isMark } from '../../lib/drawings'
import { halfClip } from '../../lib/halves'
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

/**
 * How far the eraser reaches from the pointer, in CSS pixels.
 *
 * Pixels rather than board units, because what this has to match is the hand:
 * the same reach at every zoom level, on a futsal court and on a full pitch, and
 * on a phone held at arm's length. `PropToken`'s grab boxes are the twin of
 * these — both come out 44px across under a finger — and `DrawingShape`'s corner
 * handles are deliberately half that, for the reason written there.
 *
 * **These two are a radius and the other two files hold a width**, which is a
 * trap worth naming rather than tidying away: `DrawingShape`'s `HANDLE_COARSE`
 * is also 22 and is halved at its use site, so the same literal means a 44px
 * disc here and a 22px dot there. Anyone changing one to match the other should
 * change the arithmetic, not the number.
 *
 * 22 under a finger is half of the 44px floor `src/index.css` puts under every
 * control, which is the width of the fingertip the floor was measured against —
 * so the disc is as wide as the thing driving it, and what disappears is what
 * was under it. 14 for a mouse is smaller than that on purpose: a pointer that
 * can be placed exactly should be trusted to, or erasing one arrow out of a
 * crowded box becomes impossible and the only remedy is undo.
 */
const ERASE_COARSE = 22
const ERASE_FINE = 14

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

  const coarse = useCoarsePointer()
  const perPx = boardPerPixel(mapping, pz.scale)
  /**
   * The eraser disc in board units, which is the only thing `useDrawGesture` and
   * `hitDrawings` can work in.
   *
   * **A board unit is not square** — a hundredth of the pitch length across and
   * a hundredth of its width down — so one radius in board units is a circle on
   * the board and an ellipse on the glass, and there is no scalar that is a
   * circle in both. Given the choice, the radius is taken from whichever screen
   * axis carries the pitch's *width*, which `boardPerPixel` reports as the
   * larger of its two: that makes the pixel constant above a guaranteed
   * minimum reach in every direction rather than a maximum. Sizing it from the
   * other axis would leave the disc reaching only 65% as far across the width of
   * a full pitch, and half as far on futsal, which is an eraser that visibly
   * covers a line and does not take it.
   *
   * The extra reach along the pitch's length is not hidden: the ring drawn below
   * is that same ellipse, so what is shown is exactly what will go.
   */
  const eraseRadius = () => (coarse ? ERASE_COARSE : ERASE_FINE) * Math.max(perPx.x, perPx.y)
  const draw = useDrawGesture(pointerNorm, eraseRadius)

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
    // Ahead of the lock, and deliberately outside it: a release always ends the
    // press, whatever it is or is not allowed to do with it. See `endPress`.
    draw.endPress()
    if (!locked && draw.onPointerUp()) return
    if (marquee) {
      finishMarquee(marquee)
      setMarquee(null)
    }
  })

  const ready = size.w > 0 && size.h > 0
  const cursor = pz.panning ? 'grabbing' : draw.armed ? 'crosshair' : 'default'

  /**
   * Present only while `select` is the armed tool, and handed to both bands
   * that need to know it.
   *
   * Two gestures hang off this one value: double-click a label to fix its
   * words, and drag a triangle's or a shape's corners to move them. With any
   * other tool armed those same presses mean something else — "draw here", or
   * "erase this" — so both have to be off, and a board that answered them
   * differently would be arguing with itself about what a press meant. Under the
   * eraser that is not merely untidy: a Konva node that is `draggable` begins a
   * drag on the press that is also erasing the shape it belongs to.
   * `DrawingShape` treats the handler's presence as the signal for both rather
   * than taking a second prop; see there.
   */
  const onEditText = draw.armed ? undefined : draw.editText

  /**
   * Close an open polygon, on a mouse and on a finger.
   *
   * Konva fires `dblclick` for a mouse and `dbltap` for a finger, and those are
   * two events rather than one with two names — `DrawingShape` wires both for
   * the label editor. The stage carried only `dblclick`, and the polygon's only
   * other exit is the Enter key, so on a phone the Shape tool could be started
   * and never finished: every polygon a touch user drew was abandoned, with the
   * tooltip that says "Enter to close" unreachable behind a hover it does not
   * have either. Escape has the same shape of problem and needs no fix, because
   * `Select` in the bar already says "put this tool away" without a keyboard.
   */
  const closePolygon = () => {
    if (locked) return
    draw.commitPoly()
  }

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
          onDblClick={closePolygon}
          onDblTap={closePolygon}
          onPointerDown={(e) => {
            pz.onPointerDown(e)
            const panning = pz.spaceHeldRef.current || e.evt.button === 1
            if (panning || e.evt.button !== 0) return
            // Locked: panning, zooming and selecting stay available, because
            // watching a session is not a passive activity — you still want to
            // look where you like. Only drawing is withheld.
            // The event travels with the press because the text branch has to
            // cancel it: see `useDrawGesture` for why that cancellation belongs
            // to one branch and not to every draw gesture.
            if (!locked && draw.onPointerDown(e.evt.clientX, e.evt.clientY, e.evt)) return
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
            {/* The zone band carries `onEditText` for its second meaning only:
                it is how a selected triangle or shape knows it may show corner
                handles. No zone has words to edit. */}
            <DrawingLayer mapping={mapping} test={isZone} onEditText={onEditText} />
          </Layer>
          <Layer listening={!locked}>
            <TokenLayer mapping={mapping} />
          </Layer>
          <Layer listening={!locked}>
            <DrawingLayer mapping={mapping} test={isMark} />
            {/* Double-click a label to fix its words — only while `select` is
                the tool, for the reason `onEditText` is computed above. */}
            <DrawingLayer mapping={mapping} test={isText} onEditText={onEditText} />
          </Layer>
          <Layer listening={false}>
            <PeerLayer mapping={mapping} />
            {/* The draft is clipped to the pitch on a half view for the same
                reason the committed bands are, and the clip goes on a group
                around it rather than on this layer because the peer cursors and
                the marquee share the layer and belong outside the pitch — a
                peer's pointer over the bench rail is worth seeing, and a
                rubber-band that stopped at the touchline would look broken.
                It also makes the rule visible while you draw: on a half view
                the ink stops at the edge, which is where a stroke committed out
                there would stop existing. See `halfClip` and `drawingOffHalf`. */}
            {draw.preview && (
              <Group {...halfClip(mapping.view, mapping.box)}>
                <DrawingShape drawing={draw.preview} mapping={mapping} selected={false} />
              </Group>
            )}
            {/* What the eraser would take, drawn as the region it actually
                tests rather than as a circle.

                It is a circle in board units, and board units are not square, so
                on the glass it is an ellipse — the two radii below are that one
                board radius converted back through the same per-axis factors the
                radius was made from, which is why they cannot both be the pixel
                constant. Drawing a circle instead would promise a reach the hit
                test does not have across the pitch's width and would be the
                first thing to blame when a swept line stayed put.

                Outside the half-view clip that the draft preview sits inside,
                deliberately: the draft is ink, and ink outside the shown half
                would not exist once committed, while this is a cursor. It is
                where your hand is, and a cursor that vanished at the touchline
                would read as the tool having stopped working. Gated on the lock
                for the opposite reason — while somebody else has the floor,
                nothing this ring covers can be erased, so showing it would be a
                promise the board cannot keep. */}
            {!locked && draw.eraser && (
              <Ellipse
                x={mapping.toPx(draw.eraser.nx, draw.eraser.ny).x}
                y={mapping.toPx(draw.eraser.nx, draw.eraser.ny).y}
                radiusX={draw.eraser.radius / perPx.x / pz.scale}
                radiusY={draw.eraser.radius / perPx.y / pz.scale}
                stroke="#f4f2ef"
                // Divided by the stage scale so the ring stays a hairline rather
                // than thickening as the board is zoomed into.
                strokeWidth={1 / pz.scale}
                opacity={0.55}
                listening={false}
              />
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
          // Controlled, so the words survive the box being replaced rather than
          // blurred. See `setTextValue` in `useDrawGesture`.
          value={draw.textDraft.value}
          onChange={(e) => draw.setTextValue(e.currentTarget.value)}
          placeholder="Type a label, then Enter"
          style={{ left: draw.textDraft.screenX, top: draw.textDraft.screenY }}
          onBlur={(e) => draw.blurText(e.currentTarget.value)}
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
