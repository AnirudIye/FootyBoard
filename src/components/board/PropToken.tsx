import { Arc, Group, Line, Rect, Circle } from 'react-konva'
import type Konva from 'konva'
import { useBoardStore } from '../../store/boardStore'
import { useCoarsePointer } from '../../hooks/useCoarsePointer'
import { angleDeg, arrowHead, grabBox, snapAngle } from '../../lib/geometry'
import type { PitchBox } from '../../lib/geometry'
import type { Token, TokenType } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'
import { useTokenDrag } from './useTokenDrag'

const SELECT_INK = '#f4f2ef'

/** Everything on the board that is not a player. */
type PropType = Exclude<TokenType, 'player'>

/**
 * How wide a target has to be in CSS pixels for each kind of pointer, and how
 * wide the rotation ring's band has to be.
 *
 * 44 is the app's own floor, set in `src/index.css` for every control that is
 * an element; the canvas has to keep it by hand. 32 is the mouse figure: a
 * pointer you can see lands where you aimed it, so the target only has to be
 * bigger than the shake in a hand.
 *
 * The ring gets less, deliberately. It is a band a hundred-odd pixels long
 * rather than a point, so it is far easier to hit than its width suggests, and
 * a band as wide as a finger target would reach in over the middle of the prop
 * and swallow presses meant for dragging it.
 */
const TARGET_COARSE = 44
const TARGET_FINE = 32
const BAND_COARSE = 28
const BAND_FINE = 18

/** Air around a prop's own paint, in board units, before the floor applies. */
const GRAB_PAD = 0.7

/** What Shift snaps a spin to. */
const SNAP_STEP = 15

/**
 * What each prop actually paints, as a box in units of `u` about its origin.
 *
 * Kept here beside the shapes it describes, and keyed so that adding a prop
 * type without an extent is a type error rather than a prop nobody can pick up.
 * The numbers include the parts that are not the body: a pole's shadow disc
 * sits below its foot, a mannequin's head above its shoulders, and a goal's and
 * a marker's stroke spreads half its width past the line's own coordinates.
 */
const PAINTED: Record<PropType, PitchBox> = {
  ball: { x: -0.95, y: -0.95, w: 1.9, h: 1.9 },
  cone: { x: -1.15, y: -1.5, w: 2.3, h: 2.6 },
  pole: { x: -0.5, y: -2.6, w: 1, h: 5.8 },
  goal: { x: -3.2, y: -1.2, w: 6.4, h: 2.4 },
  mannequin: { x: -0.85, y: -2.65, w: 1.7, h: 4.55 },
  arrowMarker: { x: -2.1, y: -1.15, w: 4.2, h: 2.3 },
}

interface Props {
  token: Token
  mapping: PitchMapping
  nx: number
  ny: number
  selected: boolean
}

/**
 * Everything on the board that is not a player: the ball, and training props
 * (cones, poles, mini-goals, mannequins and directional markers). Sized from
 * the pitch so they stay proportional at any format.
 *
 * The ball used to have its own component, which was this one's Group, drag and
 * selection scaffolding written out a second time.
 *
 * **The first shape drawn is one nobody ever sees.** Konva hit-tests the
 * geometry it painted, so a cone is a 22x25 triangle to a finger and a marker
 * is a line; both were close to impossible to pick up. The invisible `Rect`
 * under each body is the target you are really aiming at, and the ring below
 * has a second one for the same reason. It works because Konva's hit graph
 * honours `visible` and `listening` and takes no notice of `opacity` at all —
 * `drawHit` in konva/lib/Shape.js never calls `_applyOpacity`, and
 * `HitContext._fill` paints the shape's colour key flat — so a real fill at
 * `opacity={0}` is invisible and still solid to a pointer. That was read in
 * node_modules rather than taken on trust, because the whole feature rests on
 * it.
 *
 * The cost is real and worth stating: the empty board within a target's reach
 * of a prop now belongs to the prop, so a marquee or a click-to-deselect
 * started there picks the prop up instead. That is the trade a generous target
 * is, and props are small enough and few enough that it is the right one.
 */
export default function PropToken({ token, mapping, nx: atX, ny: atY, selected }: Props) {
  const moveToken = useBoardStore((s) => s.moveToken)
  const commit = useBoardStore((s) => s.commit)
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const openInspector = useBoardStore((s) => s.openInspector)
  // Pan and zoom scale the whole stage, so a length of `s` in these coordinates
  // reaches the eye as `s * zoom` CSS pixels. Every target below is specified in
  // pixels and divided back, or the board would grow easy to use as you zoom in
  // and impossible as you zoom out.
  const zoom = useBoardStore((s) => s.zoom)
  const coarse = useCoarsePointer()

  const u = mapping.ppm * (mapping.L / 105)
  const color = token.color
  const ballR = 0.95 * u
  const isBall = token.type === 'ball'

  const drag = useTokenDrag(mapping, isBall ? ballR : 2 * u)
  const pos = drag.place(mapping.toPx(atX, atY))

  const target = (coarse ? TARGET_COARSE : TARGET_FINE) / zoom
  const painted = token.type === 'player' ? null : PAINTED[token.type]
  const grab =
    painted &&
    grabBox(
      { x: painted.x * u, y: painted.y * u, w: painted.w * u, h: painted.h * u },
      GRAB_PAD * u,
      target,
    )

  // The ring has to clear the grab box, or its band would lie across the middle
  // of the prop and every press meant to drag the thing would spin it instead.
  // The radius the selection outline has always used is enough for a cone and
  // is not enough for a mini-goal, which is wider than it, so the ring takes
  // whichever is larger. That does mean the dashed circle is no longer one size
  // for every prop — it now hugs each one, which is what it should have been
  // doing when it was cutting straight through the goal.
  const band = (coarse ? BAND_COARSE : BAND_FINE) / zoom
  const ringR = grab ? Math.max(3.1 * u, Math.max(grab.w, grab.h) / 2 + band / 2) : 3.1 * u

  const body = () => {
    switch (token.type) {
      case 'ball':
        return (
          <>
            <Circle
              ref={drag.bodyRef}
              radius={ballR}
              fill={color}
              stroke="#17191d"
              strokeWidth={1}
              opacity={0.96}
            />
            <Circle radius={ballR * 0.4} fill="#17191d" opacity={0.75} listening={false} />
          </>
        )
      case 'cone':
        return (
          <Line
            ref={drag.bodyRef}
            points={[0, -1.5 * u, 1.15 * u, 1.1 * u, -1.15 * u, 1.1 * u]}
            closed
            fill={color}
            stroke="rgba(0,0,0,0.4)"
            strokeWidth={1}
          />
        )
      case 'pole':
        return (
          <>
            <Rect
              ref={drag.bodyRef}
              x={-0.28 * u}
              y={-2.6 * u}
              width={0.56 * u}
              height={5.2 * u}
              fill={color}
              stroke="rgba(0,0,0,0.35)"
              strokeWidth={1}
              cornerRadius={0.28 * u}
            />
            <Circle y={2.7 * u} radius={0.5 * u} fill="rgba(0,0,0,0.25)" listening={false} />
          </>
        )
      case 'goal':
        return (
          <Line
            ref={drag.bodyRef}
            points={[-3 * u, 1 * u, -3 * u, -1 * u, 3 * u, -1 * u, 3 * u, 1 * u]}
            stroke={color}
            strokeWidth={Math.max(1.5, 0.34 * u)}
            lineCap="round"
            lineJoin="round"
          />
        )
      case 'mannequin':
        return (
          <>
            <Rect
              ref={drag.bodyRef}
              x={-0.85 * u}
              y={-1.1 * u}
              width={1.7 * u}
              height={3 * u}
              fill={color}
              stroke="rgba(0,0,0,0.4)"
              strokeWidth={1}
              cornerRadius={0.5 * u}
            />
            <Circle y={-1.9 * u} radius={0.75 * u} fill={color} stroke="rgba(0,0,0,0.4)" strokeWidth={1} />
          </>
        )
      case 'arrowMarker':
        return (
          <>
            <Line
              ref={drag.bodyRef}
              points={[-1.9 * u, 0, 1.4 * u, 0]}
              stroke={color}
              strokeWidth={Math.max(1.5, 0.36 * u)}
              lineCap="round"
            />
            <Line points={[0.5 * u, -0.95 * u, 2 * u, 0, 0.5 * u, 0.95 * u]} closed fill={color} />
          </>
        )
      default:
        return null
    }
  }

  return (
    <Group
      ref={drag.ref}
      x={pos.x}
      y={pos.y}
      rotation={token.rotation}
      draggable
      dragBoundFunc={drag.dragBoundFunc}
      onContextMenu={(e) => {
        e.evt.preventDefault()
        setSelection([token.id])
        openInspector(token.id, e.evt.clientX, e.evt.clientY)
      }}
      // A press that landed on the rotation ring never reaches here: the ring
      // stops the event bubbling, precisely so this does not run. `pickUp()`
      // would put the token in its lifted state and only `putDown()` or
      // `endDrag()` takes it out again, and neither is guaranteed to fire for a
      // gesture that ends with the pointer somewhere else on the page — a prop
      // left scaled at 1.06 with a drop shadow under it and no drag to explain
      // it. Shift is the sharper reason: `toggleSelection` would deselect the
      // very prop whose ring is being grabbed, unmounting the ring under the
      // hand holding it.
      onPointerDown={(e) => {
        if (e.evt.button !== 0) return
        if (e.evt.shiftKey) toggleSelection(token.id)
        else if (!selected) setSelection([token.id])
        drag.pickUp()
      }}
      onPointerUp={() => drag.putDown()}
      onDragStart={() => drag.beginDrag()}
      onDragMove={(e) => {
        const n = mapping.toNorm(e.target.x(), e.target.y())
        moveToken(token.id, n.x, n.y)
      }}
      onDragEnd={() => {
        commit()
        // Home is wherever the store settled, which is the clamped position the
        // rest of the room has: the give was never anything but a view.
        const at = useBoardStore.getState().tokens.find((t) => t.id === token.id)
        drag.endDrag(mapping.toPx(at?.x ?? token.x, at?.y ?? token.y))
      }}
    >
      {grab && <Rect x={grab.x} y={grab.y} width={grab.w} height={grab.h} fill={SELECT_INK} opacity={0} />}
      {body()}
      {/* Above the body rather than below it, which is where the plain dashed
          circle used to sit. Konva picks the topmost shape under the pointer,
          so a ring drawn underneath the invisible grab box would never be
          caught. Nothing is hidden by the move: the ring is drawn outside the
          prop's own paint, never across it. */}
      {selected &&
        (isBall ? (
          // A ball has no orientation worth setting, so it keeps the plain
          // outline and stays a thing you only drag.
          <Circle
            radius={ballR + 3.5}
            stroke={SELECT_INK}
            strokeWidth={1.5}
            dash={[3, 3]}
            opacity={0.8}
            listening={false}
          />
        ) : (
          <RotationRing tokenId={token.id} radius={ringR} band={band} handleR={target / 2} />
        ))}
    </Group>
  )
}

interface RingProps {
  tokenId: string
  /** Where the ring sits, in the token group's own coordinates. */
  radius: number
  /** How wide the ring is to a pointer, in the same coordinates. */
  band: number
  /** How far the explicit handle reaches, likewise. */
  handleR: number
}

/** Stop a press or a drag at the ring, rather than letting the token have it. */
const consume = (e: { cancelBubble: boolean }) => {
  e.cancelBubble = true
}

/**
 * The dashed circle a selected prop wears, turned into the control that spins
 * it.
 *
 * Rotation has always existed in the data, and the only way to reach it was the
 * inspector's Facing slider, behind a right-click nobody performs on a pitch.
 * So the outline that already says "this one is selected" now also says "this
 * one turns": two curved arrows on opposite sides of it, and one filled knob
 * sitting on the ring at the prop's own facing, which is both the thing to aim
 * at and a readout of where the prop is pointing.
 *
 * **The whole assembly is one draggable node.** That is what makes the gesture
 * safe next to the token drag underneath it. Konva's `_listenDrag` refuses to
 * start a drag on a node that already has a descendant registered for one
 * (`hasDraggingChild` in konva/lib/Node.js), and the child's listener runs
 * first because the event bubbles outward — so grabbing the ring genuinely
 * takes the drag away from the token instead of racing it. Konva then fires
 * `dragstart`, `dragmove` and `dragend` with bubbling on, which would hand the
 * token's own handlers a child node's local coordinates and fling it into the
 * corner, so each one is stopped here. The token's `pointerdown` is stopped for
 * the reasons written over it.
 *
 * The cost of stopping `pointerdown` is that space-drag panning and starting a
 * drawing do not work over the ring of a selected prop. That is the right trade
 * for a control that only exists while something is selected and is asking to
 * be grabbed.
 *
 * The node is dragged and then put straight back on every move, so it never
 * actually leaves the ring; what a move is *for* is the angle from the token's
 * centre to the pointer. Putting it back survives the re-render because
 * react-konva only writes props that changed (`applyNodeProps`), and the
 * position it would write has not.
 */
function RotationRing({ tokenId, radius, band, handleR }: RingProps) {
  const updateToken = useBoardStore((s) => s.updateToken)
  const commit = useBoardStore((s) => s.commit)

  const thickness = Math.max(1.5, radius * 0.07)
  const head = Math.max(4, radius * 0.16)
  // The knob a person sees and the target they hit are two different sizes, the
  // same way `index.css` keeps a range input's track 2px inside a 44px box: a
  // knob drawn as wide as a finger would be most of the prop.
  const knob = Math.max(3.5, radius * 0.17)

  const spin = (e: Konva.KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true
    const node = e.target
    const centre = node.getParent()?.getAbsolutePosition()
    const pointer = node.getStage()?.getPointerPosition()
    if (!centre || !pointer) return
    // Both are in the stage's own screen coordinates, pan and zoom included, so
    // the angle between them needs no conversion.
    const raw = angleDeg(centre.x, centre.y, pointer.x, pointer.y)
    // Whole degrees: the store is what peers and the saved board read, and a
    // rotation of 137.42039 is noise in every one of them.
    const rotation = e.evt.shiftKey ? snapAngle(raw, SNAP_STEP) : Math.round(raw) % 360
    // `defer` holds one undo step open for the whole spin, exactly as a token
    // drag and a label drag do; the `set` and the `emit` still run per move, so
    // peers watch it turn. `commit()` on dragend closes the step.
    updateToken(tokenId, { rotation }, true)
    node.position({ x: 0, y: 0 })
  }

  return (
    <Group
      draggable
      onPointerDown={consume}
      onDragStart={consume}
      onDragMove={spin}
      onDragEnd={(e) => {
        e.cancelBubble = true
        commit()
      }}
    >
      {/* `fillEnabled={false}` is load-bearing, not tidiness. Konva's hit pass
          fills any shape whose `fillEnabled` is on, whatever its scene fill is
          — `HitContext._fill` never asks whether there is a colour — so a
          listening circle with only a stroke is solid to a pointer right across
          its face, and this one would have swallowed every press meant for the
          prop inside it. Off, only the stroke registers, widened to `band`. */}
      <Circle
        radius={radius}
        stroke={SELECT_INK}
        strokeWidth={1.5}
        dash={[3, 3]}
        opacity={0.8}
        fillEnabled={false}
        hitStrokeWidth={band}
      />
      <SpinArrow radius={radius} at={90} thickness={thickness} head={head} />
      <SpinArrow radius={radius} at={270} thickness={thickness} head={head} />
      {/* The finger target, then the knob that shows where it is. */}
      <Circle x={radius} y={0} radius={handleR} fill={SELECT_INK} opacity={0} />
      <Circle
        x={radius}
        y={0}
        radius={knob}
        fill={SELECT_INK}
        stroke="#17191d"
        strokeWidth={1}
        listening={false}
      />
    </Group>
  )
}

/** How much of the ring one curved arrow's shaft covers, in degrees. */
const ARROW_SPAN = 34

/**
 * One curved arrow lying on the ring: a slice of the ring itself for the shaft,
 * and a head on its leading end.
 *
 * Decoration, and it says so — `listening={false}` on both halves, so the two
 * things a press can land on stay the ring's stroke and the target under the
 * knob. It exists so that the ring reads as something that spins without
 * anybody being told it does, which is the one thing the Facing slider could
 * never do from inside a panel nobody opens.
 */
function SpinArrow({
  radius,
  at,
  thickness,
  head,
}: {
  radius: number
  /** Where on the ring the arrow is centred, in Konva degrees. */
  at: number
  thickness: number
  head: number
}) {
  const end = ((at + ARROW_SPAN / 2) * Math.PI) / 180
  const px = radius * Math.cos(end)
  const py = radius * Math.sin(end)
  // The tangent at the leading end, pointing the way the shaft was drawn.
  const tipX = px - Math.sin(end) * head
  const tipY = py + Math.cos(end) * head
  const [ax, ay, bx, by] = arrowHead(px, py, tipX, tipY, head)
  return (
    <>
      <Arc
        innerRadius={radius - thickness / 2}
        outerRadius={radius + thickness / 2}
        angle={ARROW_SPAN}
        rotation={at - ARROW_SPAN / 2}
        fill={SELECT_INK}
        opacity={0.8}
        listening={false}
      />
      <Line points={[ax, ay, tipX, tipY, bx, by]} closed fill={SELECT_INK} opacity={0.8} listening={false} />
    </>
  )
}
