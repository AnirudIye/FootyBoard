import { memo, useEffect, useId, useRef } from 'react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

const TWO_PI = Math.PI * 2

/**
 * A grid of dots that bulges away from the cursor, self-hosted from the
 * react-bits DotField registry entry rather than installed.
 *
 * It sits behind the features section, which is the one long stretch of the
 * page with no illustration of its own behind the copy. The dots give that
 * stretch a surface without competing with the FeatureDiagrams in front of
 * them, which is the whole brief: this is a ground, not a picture.
 *
 * Four things separate it from the export it came from.
 *
 * - **The colours are one hue.** The reference sweeps two unrelated greens
 *   past each other. This takes `--accent` and varies only its alpha, so the
 *   field reads as the accent thinning out across the section rather than as
 *   a second colour nobody chose.
 * - **Reduced motion paints the grid once and starts nothing.** No rAF loop,
 *   no speed sampler, no mousemove listener. The provider in `App.tsx` cannot
 *   reach any of those (they are not motion components), so the check has to
 *   live here. A ResizeObserver stays, because repainting a canvas that has
 *   just changed size is correctness rather than motion.
 * - **An IntersectionObserver stops the loop off screen.** Same reasoning as
 *   PlasmaWave, and more pressing here: this section is below the fold, so
 *   without it a 60fps canvas and a 50Hz timer both run while the visitor is
 *   still reading the hero.
 * - **The glow layer is optional.** It is an SVG circle chasing the cursor
 *   that takes three `setAttribute` calls a frame, and on a near-black ground
 *   there is nothing for it to add. `glow={false}` renders no SVG at all, so
 *   the writes are not merely invisible, they do not happen.
 *
 * The cursor is mapped in document space (`pageX` minus the host's offset from
 * the top of the document) rather than viewport space, so scrolling cannot put
 * the bulge in the wrong place: the rect's `top` and `window.scrollY` move by
 * the same amount and cancel. What can put it in the wrong place is a layout
 * shift above the section, which moves the host after the offsets were taken
 * and which no observer here can see, since the host's own size is unchanged.
 * So the offsets are re-read three ways: when the host resizes, on every
 * intersection change, and twice a second from inside the loop. The pointer is
 * then kept in document space and converted with those offsets once a frame,
 * because a correction cannot repair a number that was already worked out and
 * stored when the event arrived.
 */

interface Props {
  /** Diameter of a dot in CSS pixels. Drawn at half this, as the export did. */
  dotRadius?: number
  /** Gap between dots. The grid step is `dotRadius + dotSpacing`. */
  dotSpacing?: number
  /** How far from the cursor dots start to react, in CSS pixels. */
  cursorRadius?: number
  /** Push strength in the scatter mode, ignored when `bulgeOnly`. */
  cursorForce?: number
  /** Dots ease away from the cursor and back rather than being flung. */
  bulgeOnly?: boolean
  /** Peak displacement at the centre of the bulge. */
  bulgeStrength?: number
  /** Enlarges a few dots at random each frame. */
  sparkle?: boolean
  /** Standing sine offset applied to the whole grid. 0 disables it. */
  waveAmplitude?: number
  /** Gradient start, top left. Any canvas colour string. */
  gradientFrom?: string
  /** Gradient end, bottom right. */
  gradientTo?: string
  /** Renders the cursor glow. Off means the SVG is never mounted. */
  glow?: boolean
  glowRadius?: number
  glowColor?: string
  className?: string
}

interface Dot {
  /** Anchor: where this dot rests, and what it eases back to. */
  ax: number
  ay: number
  /** Smoothed drawing position. */
  sx: number
  sy: number
  /** Velocity and integrated position, scatter mode only. */
  vx: number
  vy: number
  x: number
  y: number
}

export default memo(function DotField({
  dotRadius = 1.5,
  dotSpacing = 14,
  cursorRadius = 500,
  cursorForce = 0.1,
  bulgeOnly = true,
  bulgeStrength = 67,
  sparkle = false,
  waveAmplitude = 0,
  gradientFrom = 'rgba(168, 85, 247, 0.35)',
  gradientTo = 'rgba(180, 151, 207, 0.25)',
  glow = true,
  glowRadius = 160,
  glowColor = '#120F17',
  className = '',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glowRef = useRef<SVGCircleElement>(null)
  const reduced = useReducedMotion()

  // The loop reads its settings through a ref so changing a prop never has to
  // tear the canvas down and start the field over.
  const propsRef = useRef({
    dotRadius, dotSpacing, cursorRadius, cursorForce,
    bulgeOnly, bulgeStrength, sparkle, waveAmplitude, gradientFrom, gradientTo,
  })
  propsRef.current = {
    dotRadius, dotSpacing, cursorRadius, cursorForce,
    bulgeOnly, bulgeStrength, sparkle, waveAmplitude, gradientFrom, gradientTo,
  }

  // Two instances on one page would otherwise share a gradient id. Colons are
  // legal in a fragment reference but read badly in `url(#...)`, so they go.
  const glowId = `dot-field-glow-${useId().replace(/:/g, '')}`

  const rebuildRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    // jsdom has no 2D context, and neither does a browser that has run out of
    // them. Nothing here degrades: the section keeps its own background.
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !host || !ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)

    let dots: Dot[] = []
    const size = { w: 0, h: 0, offsetX: 0, offsetY: 0 }
    // Held in document space, and converted to canvas space once per frame
    // rather than once per event. Storing the converted value is what makes a
    // corrected offset arrive too late to matter: the correction lands, and
    // the number it was supposed to fix was worked out three frames ago and is
    // not recomputed until the pointer next moves.
    const mouse = { docX: -99999, docY: -99999, prevX: -99999, prevY: -99999, speed: 0 }
    let engagement = 0
    let glowOpacity = 0
    let frameCount = 0
    let frame = 0
    let speedTimer: ReturnType<typeof setInterval> | undefined
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let running = false

    function buildDots(w: number, h: number) {
      const p = propsRef.current
      const step = p.dotRadius + p.dotSpacing
      const cols = Math.floor(w / step)
      const rows = Math.floor(h / step)
      const padX = (w % step) / 2
      const padY = (h % step) / 2
      const next: Dot[] = new Array(Math.max(rows * cols, 0))
      let idx = 0

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step + step / 2
          const ay = padY + row * step + step / 2
          next[idx++] = { ax, ay, sx: ax, sy: ay, vx: 0, vy: 0, x: ax, y: ay }
        }
      }
      dots = next
    }

    /**
     * `live: false` is the resting grid: dots on their anchors, no wave, no
     * sparkle, no cursor. That is both what reduced motion gets and what is on
     * screen before the loop has started, so the two cannot drift apart.
     */
    function render(live: boolean) {
      const p = propsRef.current
      const { w, h } = size
      if (!ctx || w === 0 || h === 0) return

      ctx.clearRect(0, 0, w, h)
      const grad = ctx.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, p.gradientFrom)
      grad.addColorStop(1, p.gradientTo)
      ctx.fillStyle = grad

      const rad = p.dotRadius / 2
      ctx.beginPath()

      if (!live) {
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i]
          ctx.moveTo(d.ax + rad, d.ay)
          ctx.arc(d.ax, d.ay, rad, 0, TWO_PI)
        }
        ctx.fill()
        return
      }

      const t = frameCount * 0.02
      const cr = p.cursorRadius
      const crSq = cr * cr
      const isBulge = p.bulgeOnly
      const eng = engagement
      // Converted here, from the freshest offsets, rather than when the event
      // arrived. See the note on `mouse`.
      const mx = mouse.docX - size.offsetX
      const my = mouse.docY - size.offsetY

      for (let i = 0; i < dots.length; i++) {
        const d = dots[i]
        const dx = mx - d.ax
        const dy = my - d.ay
        const distSq = dx * dx + dy * dy

        if (distSq < crSq && eng > 0.01) {
          const dist = Math.sqrt(distSq)
          const angle = Math.atan2(dy, dx)
          if (isBulge) {
            const falloff = 1 - dist / cr
            const push = falloff * falloff * p.bulgeStrength * eng
            d.sx += (d.ax - Math.cos(angle) * push - d.sx) * 0.15
            d.sy += (d.ay - Math.sin(angle) * push - d.sy) * 0.15
          } else {
            const move = (500 / dist) * (mouse.speed * p.cursorForce)
            d.vx += Math.cos(angle) * -move
            d.vy += Math.sin(angle) * -move
          }
        } else if (isBulge) {
          d.sx += (d.ax - d.sx) * 0.1
          d.sy += (d.ay - d.sy) * 0.1
        }

        if (!isBulge) {
          d.vx *= 0.9
          d.vy *= 0.9
          d.x = d.ax + d.vx
          d.y = d.ay + d.vy
          d.sx += (d.x - d.sx) * 0.1
          d.sy += (d.y - d.sy) * 0.1
        }

        let drawX = d.sx
        let drawY = d.sy
        if (p.waveAmplitude > 0) {
          drawY += Math.sin(d.ax * 0.03 + t) * p.waveAmplitude
          drawX += Math.cos(d.ay * 0.03 + t * 0.7) * p.waveAmplitude * 0.5
        }

        // A cheap hash keeps the twinkle scattered rather than banded, and
        // changes set every eight frames rather than every frame.
        const big = p.sparkle && ((((i * 2654435761) ^ (frameCount >> 3)) >>> 0) % 100) < 3
        const r = big ? rad * 1.8 : rad
        ctx.moveTo(drawX + r, drawY)
        ctx.arc(drawX, drawY, r, 0, TWO_PI)
      }

      ctx.fill()
    }

    function doResize() {
      if (!canvas || !host || !ctx) return
      const rect = host.getBoundingClientRect()

      // Document space, so scrolling does not invalidate it. This runs from
      // three places, and the rest of the function from one: everything below
      // the size check is the expensive half and only a real resize needs it.
      size.offsetX = rect.left + window.scrollX
      size.offsetY = rect.top + window.scrollY

      if (rect.width === size.w && rect.height === size.h) return
      size.w = rect.width
      size.h = rect.height

      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      buildDots(rect.width, rect.height)
      // Writing `canvas.width` clears it. The loop repaints on its next frame;
      // nothing else does, so a paused or reduced-motion field repaints here.
      if (!running) render(false)
    }

    rebuildRef.current = () => {
      buildDots(size.w, size.h)
      if (!running) render(false)
    }

    doResize()

    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doResize, 100)
    })
    ro.observe(host)

    if (reduced) {
      // The whole point of the branch: no rAF, no interval, no mousemove.
      // `doResize` has already painted the resting grid, and the observer
      // repaints it if the section changes size.
      return () => {
        clearTimeout(resizeTimer)
        ro.disconnect()
        rebuildRef.current = null
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      mouse.docX = e.pageX
      mouse.docY = e.pageY
    }

    // Speed is a distance, so it is the same number in either space and the
    // offsets would only cancel out again.
    function updateMouseSpeed() {
      const dx = mouse.prevX - mouse.docX
      const dy = mouse.prevY - mouse.docY
      const dist = Math.sqrt(dx * dx + dy * dy)
      mouse.speed += (dist - mouse.speed) * 0.5
      if (mouse.speed < 0.001) mouse.speed = 0
      mouse.prevX = mouse.docX
      mouse.prevY = mouse.docY
    }

    function tick() {
      frameCount++

      // Twice a second, and only while the field is on screen. Between them
      // the two observers catch a host that resizes and a section scrolled
      // back into view, but neither fires for the case that actually strands
      // the cursor: something above the section changing height while the
      // section is already in view and under the pointer. `doResize` is one
      // rect read and two assignments unless the size really changed, so this
      // is cheap enough to be the backstop rather than a third observer.
      if (frameCount % 30 === 0) doResize()

      const target = Math.min(mouse.speed / 5, 1)
      engagement += (target - engagement) * 0.06
      if (engagement < 0.001) engagement = 0

      const glowEl = glowRef.current
      if (glowEl) {
        glowOpacity += (engagement - glowOpacity) * 0.08
        glowEl.setAttribute('cx', String(mouse.docX - size.offsetX))
        glowEl.setAttribute('cy', String(mouse.docY - size.offsetY))
        glowEl.style.opacity = String(glowOpacity)
      }

      render(true)
      frame = requestAnimationFrame(tick)
    }

    const start = () => {
      if (running) return
      running = true
      // Resuming against a sample taken before the pause reads as one enormous
      // jump, and the field would bulge at full strength the moment it appears.
      mouse.prevX = mouse.docX
      mouse.prevY = mouse.docY
      mouse.speed = 0
      speedTimer = setInterval(updateMouseSpeed, 20)
      frame = requestAnimationFrame(tick)
    }

    const stop = () => {
      running = false
      cancelAnimationFrame(frame)
      clearInterval(speedTimer)
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true })

    // The features section is below the fold, so off screen is where it starts
    // and where it spends most of a visit.
    const io = new IntersectionObserver(
      ([entry]) => {
        doResize()
        if (entry.isIntersecting) start()
        else stop()
      },
      { rootMargin: '120px' },
    )
    io.observe(host)

    return () => {
      stop()
      io.disconnect()
      ro.disconnect()
      clearTimeout(resizeTimer)
      window.removeEventListener('mousemove', onMouseMove)
      rebuildRef.current = null
    }
  }, [reduced])

  // Grid geometry and colour are the only props the running loop cannot pick
  // up on its own, since the dots are built once and the paused field is not
  // repainting.
  useEffect(() => {
    rebuildRef.current?.()
  }, [dotRadius, dotSpacing, gradientFrom, gradientTo])

  return (
    <div className={`relative h-full w-full ${className}`}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {glow && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <defs>
            <radialGradient id={glowId}>
              <stop offset="0%" stopColor={glowColor} />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>
          <circle
            ref={glowRef}
            cx="-9999"
            cy="-9999"
            r={glowRadius}
            fill={`url(#${glowId})`}
            style={{ opacity: 0, willChange: 'opacity' }}
          />
        </svg>
      )}
    </div>
  )
})
