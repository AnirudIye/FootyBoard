import type { PitchBox } from './geometry'
import type { Drawing, PitchView } from './types'

/**
 * Where the halfway line is, stated once for everything that has to agree.
 *
 * A half view draws half a pitch: `pitchMapping`'s DOMAIN is [50,100] for
 * `attackHalf` and [0,50] for `defendHalf`, and `toPx` is linear and unclamped,
 * so anything stored on the other half is not merely off the end of the pitch —
 * it is painted on the bare canvas beside it, in full view. Three bands of the
 * board therefore need the same answer to "is this on the half we are showing",
 * and until now only two of them had one.
 *
 * These rules lived in `TokenLayer`, which is a component file that the canvas
 * and the marquee already had to import from, and the drawing bands would have
 * been a third importer. They are here instead so there is exactly one statement
 * of where the line is and one dead band around it. `onScreen` and `lastDrawn`
 * stayed behind, because those are about what that layer drew rather than about
 * the line.
 */

/** Which half a view shows, or null when the whole pitch is on screen. */
export const halfShown = (view: PitchView): 'attack' | 'defend' | null =>
  view === 'attackHalf' ? 'attack' : view === 'defendHalf' ? 'defend' : null

// Off-half *players* are hidden (they are formation context you manage from the
// picker), but the ball and any props must stay reachable: they are clamped to
// the visible edge so they can always be grabbed and pulled back onto the field,
// never stranded off-view.
//
// Both rules are exported because selection has to agree with them. A marquee
// working off raw stored positions caught players nobody could see, and missed
// props at the edge it had itself put there.

/** Whether a player is off the shown half, and so not on screen at all. */
export const playerHidden = (view: PitchView, nx: number): boolean => {
  const half = halfShown(view)
  if (half === 'attack') return nx < 48
  if (half === 'defend') return nx > 52
  return false
}

/** Where a ball or prop is actually drawn, which is never outside the view. */
export const shownX = (view: PitchView, nx: number): number => {
  const half = halfShown(view)
  if (half === 'attack') return Math.max(nx, 50.5)
  if (half === 'defend') return Math.min(nx, 49.5)
  return nx
}

/**
 * Whether a drawing is entirely off the shown half, and so not drawn at all.
 *
 * Every point has to be off it, and the control point with them: a curve bows
 * out to wherever that point is, so a pass whose ends are both behind the
 * halfway line can still arc across it, and hiding it would take the visible
 * arc away with it. A drawing that straddles the line is not hidden but
 * clipped — see `halfClip` — so the part on the far side is cut at the pitch
 * edge rather than painted beside it.
 *
 * **The same 48/52 dead band a player uses, and that is the point rather than
 * convenience.** A drawing is nearly always about the players around it, so the
 * two have to disappear on the same line. Judged against a hard 50, an arrow
 * starting from a defender at 49 would vanish while the defender it starts from
 * is still on the attacking half's screen, leaving a chip with the instruction
 * attached to it missing. The band exists at all because a chip is a disc and
 * one sitting on the line is drawn either side of it; a stroke laid along the
 * line has exactly the same problem for exactly the same reason.
 */
export function drawingOffHalf(view: PitchView, d: Drawing): boolean {
  if (!halfShown(view)) return false
  for (let i = 0; i < d.points.length; i += 2) {
    if (!playerHidden(view, d.points[i])) return false
  }
  return d.control ? playerHidden(view, d.control[0]) : true
}

/** Konva `Group` clip attributes, or nothing at all. See `halfClip`. */
export interface HalfClip {
  clipX?: number
  clipY?: number
  clipWidth?: number
  clipHeight?: number
}

/**
 * The clip a band of drawings is painted under: the pitch rectangle on a half
 * view, and nothing whatsoever on the full, vertical and blank ones.
 *
 * "Nothing whatsoever" is the load-bearing half of that. On a whole pitch an
 * annotation that runs a little past the touchline — a label written in the
 * margin, an arrow that starts from off the field — is legitimate, is drawn
 * today, and clipping it would be a silent regression nobody asked for. On a
 * half view the same overflow is not a margin: it is the other half of the
 * pitch, drawn on bare canvas next to the half being shown.
 *
 * Pass `mapping.box`, which is the drawn rectangle and which `useAnimatedMapping`
 * blends during a view change, so the clip moves and resizes with the pitch
 * instead of snapping to its final shape. Because the drawing's pixels blend on
 * the same schedule, a straddling shape slides out under the edge as the half
 * closes in on it rather than being cut off a frame early.
 *
 * The empty object is genuinely "no clip": Konva only clips when both a width
 * and a height are numbers, and react-konva unsets an attribute that stops
 * being passed, so leaving a half view removes the clip rather than freezing it.
 */
export function halfClip(view: PitchView, box: PitchBox): HalfClip {
  if (!halfShown(view)) return {}
  return { clipX: box.x, clipY: box.y, clipWidth: box.w, clipHeight: box.h }
}
