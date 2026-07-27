/*
  Motion tokens.

  The palette lives in tokens.css and the timing lives here, for the same
  reason: a value used in eight places should be named once. Framer Motion
  reads these directly, so a component states what kind of movement it wants
  rather than re-deriving a spring from four numbers.

  Springs are written as {bounce, duration} rather than stiffness/damping/mass.
  It is the same spring either way — framer-motion v12 solves one
  parameterisation into the other — but bounce and duration are the two things
  you can actually see, so they are the two worth arguing about. bounce is the
  overshoot (0 settles without ever passing the target) and duration is roughly
  how long it takes to look finished.

  Every spring here has bounce: 0. Overshoot belongs to motion that continues a
  gesture the hand already gave momentum to, a flick or a throw, where stopping
  dead reads as the surface catching rather than settling. Nothing in the app is
  momentum-driven today: chips follow the pointer exactly and stop where it
  stopped. That is why there is no SPRING_THROW yet, and why adding one should
  wait for a gesture that earns it.
*/

/** Direct manipulation and small state changes: the answer arrives at once. */
export const SPRING_SNAP = { type: 'spring', bounce: 0, duration: 0.3 } as const

/** Larger travel, or something entering: enough time to be followed by eye. */
export const SPRING_SOFT = { type: 'spring', bounce: 0, duration: 0.4 } as const

/** Tweens that arrive: fast out of the gate, long tail. Entrances, reveals. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const

/** Tweens that leave: slow to commit, then gone. Exits and dismissals. */
export const EASE_IN = [0.64, 0, 0.78, 0] as const
