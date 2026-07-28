import { useEffect, useRef, useState } from 'react'
import { Renderer, Program, Mesh, Geometry } from 'ogl'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

/**
 * A slow field of light behind the closing section, self-hosted from the
 * react-bits PlasmaWave registry entry rather than imported.
 *
 * It is deliberately the only WebGL field on the page and deliberately not in
 * the hero: the hero already has FloodlitBackdrop and the passing move, and a
 * second moving light behind them would be two things competing for the same
 * attention. Here there is one line of copy and one button, and the field is
 * what makes the last screen feel like an invitation rather than a footer.
 *
 * Both colours are green on purpose. The reference sweeps two hues past each
 * other, which is pretty and belongs to a different product; taking the accent
 * and the deep green already in the headline gradient keeps it reading as one
 * light source over black rather than as a gradient demo.
 *
 * Three things keep it cheap and safe, and all three matter:
 *
 * - Reduced motion never mounts the canvas at all. A WebGL loop is not
 *   something a CSS media query can throttle, so the answer has to be to not
 *   start it; what renders instead is a static gradient of the same two
 *   colours, which is the same picture with the movement taken out.
 * - A failed context falls back to exactly that gradient. Old machines, a
 *   blocklisted driver and a browser that has run out of contexts all arrive
 *   here, and none of them should get a black band where the section was.
 * - An IntersectionObserver stops the loop while the section is off screen,
 *   which for a section at the bottom of a long page is most of the time.
 */

interface Props {
  /** Two hex colours, `[near, far]`. Both green here, by design. */
  colors: [string, string]
  speed1?: number
  speed2?: number
  dir2?: number
  focalLength?: number
  bend1?: number
  bend2?: number
  rotationDeg?: number
  xOffset?: number
  yOffset?: number
  className?: string
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return [r, g, b]
}

const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

const VERT = 'attribute vec2 position; void main(){ gl_Position = vec4(position,0.,1.); }'

const FRAG = /* glsl */ `
precision mediump float;
uniform float iTime; uniform vec2 iResolution; uniform vec2 uOffset;
uniform float uRotation; uniform float uFocalLength;
uniform float uSpeed1; uniform float uSpeed2; uniform float uDir2;
uniform float uBend1; uniform float uBend2; uniform vec3 uColor1; uniform vec3 uColor2;
const float lt=0.3; const float pi=3.14159; const float pi2=6.28318; const float pi_2=1.5708;
#define MAX_STEPS 14
void mainImage(out vec4 C, in vec2 U){
  float t=iTime*pi; float s=1.0; float d=0.0; vec2 R=iResolution;
  vec3 o=vec3(0.,0.,-7.); vec3 u=normalize(vec3((U-0.5*R)/R.y,uFocalLength));
  vec2 k=vec2(0.); vec3 p;
  float t1=t*0.7; float t2=t*0.9; float tS1=t*uSpeed1; float tS2=t*uSpeed2*uDir2;
  for(int i=0;i<MAX_STEPS;++i){
    p=o+u*d; p.x-=15.0; float px=p.x;
    float w1=uBend1+sin(t1+px*0.8)*0.1; float w2=uBend2+cos(t2+px*1.1)*0.1;
    float px2=px+pi_2;
    vec2 sO=sin(vec2(px,px2)+tS1)*w1; vec2 cO=cos(vec2(px,px2)+tS2)*w2;
    vec2 yz=p.yz; float pxLt=px+lt;
    k.x=max(pxLt,length(yz-sO)-lt); k.y=max(pxLt,length(yz-cO)-lt);
    float cur=min(k.x,k.y); s=min(s,cur);
    if(s<0.001||d>300.0) break; d+=s*0.7;
  }
  float sq=sqrt(d);
  vec3 raw=max(cos(d*pi2)-s*sq-vec3(k,0.),0.); raw.gb+=0.1;
  float mx=max(raw.r,max(raw.g,raw.b)); if(mx<0.15) discard;
  raw=raw*0.4+raw.brg*0.6+raw*raw;
  float lum=dot(raw,vec3(0.299,0.587,0.114));
  float wA=max(0.,1.-k.x*2.); float wB=max(0.,1.-k.y*2.); float wt=wA+wB+0.001;
  vec3 c=(uColor1*wA+uColor2*wB)/wt*lum*3.5; C=vec4(c,1.);
}
void main(){
  vec2 coord=gl_FragCoord.xy+uOffset; coord-=0.5*iResolution;
  float c=cos(uRotation), s=sin(uRotation);
  coord=mat2(c,-s,s,c)*coord; coord+=0.5*iResolution;
  vec4 color; mainImage(color,coord); gl_FragColor=color;
}`

export default function PlasmaWave({
  colors,
  speed1 = 0.05,
  speed2 = 0.05,
  dir2 = 1,
  focalLength = 0.8,
  bend1 = 1,
  bend2 = 0.5,
  rotationDeg = 0,
  xOffset = 0,
  yOffset = 0,
  className = '',
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [failed, setFailed] = useState(false)

  // The loop reads its settings through a ref so changing a prop never has to
  // tear down the context and start the field over from t = 0.
  const propsRef = useRef({ speed1, speed2, dir2, focalLength, bend1, bend2, rotationDeg, xOffset, yOffset })
  propsRef.current = { speed1, speed2, dir2, focalLength, bend1, bend2, rotationDeg, xOffset, yOffset }

  useEffect(() => {
    if (reduced) return
    const host = hostRef.current
    if (!host) return

    let renderer: Renderer
    try {
      renderer = new Renderer({
        alpha: true,
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
        antialias: false,
        depth: false,
        stencil: false,
      })
      if (!renderer.gl) throw new Error('no context')
    } catch {
      setFailed(true)
      return
    }

    const gl = renderer.gl
    gl.clearColor(0, 0, 0, 0)

    // One triangle big enough to cover the clip volume: cheaper than a quad and
    // it never shows the diagonal seam two triangles do.
    const geometry = new Geometry(gl, {
      position: { size: 2, data: new Float32Array([-1, -1, 3, -1, -1, 3]) },
    })

    const [c1, c2] = colors
    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: [1, 1] },
        uOffset: { value: [0, 0] },
        uRotation: { value: 0 },
        uFocalLength: { value: focalLength },
        uSpeed1: { value: speed1 },
        uSpeed2: { value: speed2 },
        uDir2: { value: dir2 },
        uBend1: { value: bend1 },
        uBend2: { value: bend2 },
        uColor1: { value: hexToRgb(c1) },
        uColor2: { value: hexToRgb(c2) },
      },
    })

    const mesh = new Mesh(gl, { geometry, program })
    gl.canvas.style.display = 'block'
    gl.canvas.style.width = '100%'
    gl.canvas.style.height = '100%'
    host.appendChild(gl.canvas)

    const resize = () => {
      const rect = host.getBoundingClientRect()
      renderer.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1))
      program.uniforms.iResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight]
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    let elapsed = 0
    let last = performance.now()
    let frame = 0
    let running = false

    const update = (now: number) => {
      frame = requestAnimationFrame(update)
      // Clamped, so coming back from a paused tab or a stopped loop resumes
      // where the field was rather than jumping a minute of drift at once.
      elapsed += Math.min((now - last) / 1000, 0.05)
      last = now

      const p = propsRef.current
      program.uniforms.iTime.value = elapsed
      program.uniforms.uOffset.value = [p.xOffset * renderer.dpr, p.yOffset * renderer.dpr]
      program.uniforms.uRotation.value = (p.rotationDeg * Math.PI) / 180
      program.uniforms.uFocalLength.value = p.focalLength
      program.uniforms.uSpeed1.value = p.speed1
      program.uniforms.uSpeed2.value = p.speed2
      program.uniforms.uDir2.value = p.dir2
      program.uniforms.uBend1.value = p.bend1
      program.uniforms.uBend2.value = p.bend2
      renderer.render({ scene: mesh })
    }

    const start = () => {
      if (running) return
      running = true
      last = performance.now()
      frame = requestAnimationFrame(update)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(frame)
    }

    // This section is the last thing on a long page, so "off screen" is its
    // normal state and the loop should not be the page's steady-state cost.
    const io = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? start() : stop()),
      { rootMargin: '120px' },
    )
    io.observe(host)

    return () => {
      stop()
      io.disconnect()
      ro.disconnect()
      gl.canvas.remove()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    // Only `reduced` can rebuild the context. Everything else the loop needs it
    // reads through propsRef, and the colours are constants at the call site.
  }, [reduced, colors])

  if (reduced || failed) {
    // The echo has to survive whatever scrim the caller puts over a field that
    // was tuned for a moving, near-white-cored shader, which is why these
    // alphas are so much higher than the plasma's average brightness. They are
    // also placed low, where the streaks pool, rather than up behind the
    // headline: same picture, movement taken out, contrast left alone.
    return (
      <div
        aria-hidden
        className={className}
        style={{
          background: `radial-gradient(60% 62% at 26% 62%, ${rgba(colors[0], 0.5)}, transparent 70%),
            radial-gradient(58% 66% at 76% 68%, ${rgba(colors[1], 0.8)}, transparent 72%)`,
        }}
      />
    )
  }

  return <div ref={hostRef} aria-hidden className={className} />
}
