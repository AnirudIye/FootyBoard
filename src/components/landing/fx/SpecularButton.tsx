import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Renderer, Program, Mesh, Triangle } from 'ogl'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

/**
 * A specular rim light for the one control the page is actually asking you to
 * press. A highlight travels the button's rounded-rect edge, brightening and
 * aiming toward the cursor as it comes within `PROXIMITY`, and sitting dark
 * otherwise.
 *
 * Adapted from react-bits' SpecularButton (the shader is theirs, near enough
 * verbatim) rather than reimplemented, and self-hosted rather than imported:
 * `ogl` is already a dependency for the closing section's plasma field, so the
 * WebGL version costs nothing extra and is the faithful one. A CSS conic
 * gradient masked to a border ring can get close, but not to the gaussian
 * falloff along a signed-distance edge, which is the part that reads as light
 * on a bevel rather than as a rotating gradient.
 *
 * Three things this does that the reference does not, all for this page:
 *
 * 1. It wraps a child rather than being a button. The CTA is a router <Link>,
 *    and the canvas sits over it as a sibling, because `.liquid-glass` sets
 *    `overflow: hidden` and would clip the outer half of a rim drawn inside it.
 * 2. It stops the rAF loop once the highlight has faded out, and the pointer
 *    listener starts it again. Two of these render on the landing page, over a
 *    section that is already running a WebGL field; none of them should be
 *    burning a frame budget to draw an unchanging dark ring.
 * 3. Keyboard focus lights it, since a highlight only the mouse can summon is
 *    a state half the users of a link cannot reach.
 *
 * Colours come from the tokens, read once at mount, so the rim is the same
 * green as everything else and follows the ramp if the ramp moves.
 */

/** Slack around the button, in CSS px, so the rim's outer falloff is not cut. */
const PAD = 20

/** How close the pointer has to get before the highlight is at full strength. */
const PROXIMITY = 250

/** The resting diagonal: the angle that frames the corners. */
const IDLE_ANGLE = 2.4

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;

out vec4 fragColor;

float sdRoundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float gaussianLine(float d, float sigma) {
  float x = d / (sigma + 1e-6);
  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));
  return exp(-k * x * x);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = sdRoundedRect(p, uHalfSize, uRadius);
  vec2 L = vec2(cos(uAngle), sin(uAngle));

  // Dark base stroke hugging the edge, for a sense of thickness.
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;

  // Symmetric specular: the edges facing toward and away from the light both
  // catch a streak. The angular window is measured with an elliptical normal
  // so it varies continuously along the straight edges as well as the corners.
  vec2 nEll = normalize(p / (uHalfSize * uHalfSize) + 1e-6);
  float phi = acos(clamp(abs(dot(nEll, L)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);
  float lineFalloff = gaussianLine(d, uThickness);
  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));
  float hi = lineFalloff * rim * edgeClamp * uIntensity;

  vec3 col = uBaseColor * base + uLineColor * hi;
  float a = clamp(base + hi, 0.0, 1.0);
  fragColor = vec4(col, a);
}
`

/** Reads a `r g b` token off :root and returns it as three 0..1 floats. */
function tokenRgb(name: string): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const [r, g, b] = raw.trim().split(/[\s,]+/).map(Number)
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
    ? [r / 255, g / 255, b / 255]
    : [1, 1, 1]
}

export function SpecularButton({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const fxRef = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const host = hostRef.current
    const fx = fxRef.current
    if (!host || !fx) return

    // Old machines, blocked contexts, and the "too many contexts" ceiling all
    // land here, and all of them should leave a perfectly good glass button.
    let renderer: Renderer
    try {
      renderer = new Renderer({
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      })
      // The shader is `#version 300 es`; there is no WebGL1 path for it.
      if (!renderer.isWebgl2) {
        renderer.gl.getExtension('WEBGL_lose_context')?.loseContext()
        return
      }
    } catch {
      return
    }

    const gl = renderer.gl
    const dpr = renderer.dpr
    gl.clearColor(0, 0, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const geometry = new Triangle(gl)
    if (geometry.attributes.uv) delete geometry.attributes.uv

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uCenter: { value: [0, 0] },
        uHalfSize: { value: [1, 1] },
        uRadius: { value: 0 },
        uAngle: { value: IDLE_ANGLE },
        uPx: { value: dpr },
        uLineColor: { value: tokenRgb('--accent') },
        // The dim desaturated green already on the ramp, so the resting ring
        // is the same family as the hairlines it sits among.
        uBaseColor: { value: tokenRgb('--rule-strong') },
        uIntensity: { value: 0 },
        uShineSize: { value: (10 * Math.PI) / 180 },
        uShineFade: { value: (40 * Math.PI) / 180 },
        uThickness: { value: dpr },
        uBaseWidth: { value: dpr },
      },
    })

    const mesh = new Mesh(gl, { geometry, program })
    fx.appendChild(gl.canvas)

    // Fractional size plus an explicit centre keeps the SDF pinned to the exact
    // CSS border rather than drifting up to a pixel from offsetWidth rounding.
    const resize = () => {
      const rect = host.getBoundingClientRect()
      renderer.setSize(rect.width + PAD * 2, rect.height + PAD * 2)
      program.uniforms.uCenter.value = [(PAD + rect.width / 2) * dpr, (PAD + rect.height / 2) * dpr]
      program.uniforms.uHalfSize.value = [(rect.width / 2) * dpr, (rect.height / 2) * dpr]
      program.uniforms.uRadius.value = (Math.min(rect.width, rect.height) / 2) * dpr
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    const draw = (angle: number, intensity: number) => {
      program.uniforms.uAngle.value = angle
      program.uniforms.uIntensity.value = intensity
      renderer.render({ scene: mesh })
    }

    // Focus and hover are tracked in both modes, because the highlight is the
    // only affordance saying the control is live, and a keyboard has no cursor.
    // `wake` is assigned by whichever mode this ends up in, below.
    let lit = false
    let wake: () => void = () => {}
    const onEnter = () => {
      lit = true
      wake()
    }
    const onLeave = () => {
      lit = false
      wake()
    }
    const onFocusIn = (e: FocusEvent) => {
      if ((e.target as Element | null)?.matches?.(':focus-visible')) onEnter()
    }

    host.addEventListener('pointerenter', onEnter)
    host.addEventListener('pointerleave', onLeave)
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', onLeave)

    if (reduced) {
      // Asked for less motion: no idle sweep, no cursor tracking, no loop. The
      // highlight is a state, arriving whole on hover or focus and leaving the
      // same way, pinned to the diagonal that frames the corners.
      let staticFrame = 0
      wake = () => {
        cancelAnimationFrame(staticFrame)
        staticFrame = requestAnimationFrame(() => draw(IDLE_ANGLE, lit ? 1 : 0))
      }
      wake()

      return () => {
        cancelAnimationFrame(staticFrame)
        ro.disconnect()
        host.removeEventListener('pointerenter', onEnter)
        host.removeEventListener('pointerleave', onLeave)
        host.removeEventListener('focusin', onFocusIn)
        host.removeEventListener('focusout', onLeave)
        gl.canvas.remove()
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }

    let pointerAngle: number | null = null
    let proximity = 0
    const onPointerMove = (e: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = Math.max(rect.left - e.clientX, 0, e.clientX - rect.right)
      const dy = Math.max(rect.top - e.clientY, 0, e.clientY - rect.bottom)
      const dist = Math.hypot(dx, dy)
      if (dist === 0) {
        // Over the button the light settles on the diagonal and only sways with
        // the cursor, rather than whipping around as it crosses the centre.
        const nx = (e.clientX - cx) / (rect.width / 2)
        const ny = (cy - e.clientY) / (rect.height / 2)
        pointerAngle = Math.atan2(2 / rect.height, -2 / rect.width) + nx * 0.3 + ny * 0.15
      } else {
        pointerAngle = Math.atan2(cy - e.clientY, e.clientX - cx)
      }
      const t = Math.max(0, 1 - dist / PROXIMITY)
      proximity = t * t * (3 - 2 * t)
      if (proximity > 0) wake()
    }
    window.addEventListener('pointermove', onPointerMove)

    let angle = IDLE_ANGLE
    let bright = 0
    let last = performance.now()
    let frame = 0
    let running = false

    const update = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      const target = pointerAngle ?? IDLE_ANGLE
      const diff = ((target - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      angle += diff * (1 - Math.exp(-dt * 7))

      const want = lit ? 1 : proximity
      bright += (want - bright) * (1 - Math.exp(-dt * 8))
      draw(angle, bright)

      // Nothing left to show and nothing asking for it: stand down until the
      // pointer comes back within PROXIMITY, or focus lands. The frame just
      // drawn still carries the resting base ring, which does not animate.
      if (want === 0 && bright < 0.004) {
        running = false
        return
      }
      frame = requestAnimationFrame(update)
    }

    wake = () => {
      if (running) return
      running = true
      last = performance.now()
      frame = requestAnimationFrame(update)
    }
    draw(angle, 0)

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerenter', onEnter)
      host.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', onLeave)
      gl.canvas.remove()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [reduced])

  return (
    <span ref={hostRef} className="relative inline-flex">
      {children}
      <span
        ref={fxRef}
        aria-hidden
        className="pointer-events-none absolute -inset-5 z-[1] [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full"
      />
    </span>
  )
}
