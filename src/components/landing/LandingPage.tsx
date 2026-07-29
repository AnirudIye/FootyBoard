import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion, useScroll, useTransform } from 'framer-motion'
import ScrollProgress from './ScrollProgress'
import FloodlitBackdrop from './FloodlitBackdrop'
import TacticalLoop from './TacticalLoop'
import MiniPitch from './MiniPitch'
import { FeatureDiagram } from './FeatureDiagram'
import type { DiagramName } from './FeatureDiagram'
import { Reveal } from './fx/Reveal'
import { Magnetic } from './fx/Magnetic'
import { ClickSpark } from './fx/ClickSpark'
import { SpecularButton } from './fx/SpecularButton'
import PlasmaWave from './fx/PlasmaWave'
import DotField from './fx/DotField'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useAuthStore } from '../../store/authStore'

// The page's three greens, named once. The signal is the accent token itself;
// the deep and the pale are the ends of the headline's own ramp.
const GREEN_DEEP = '#0f7a45'
const GREEN_SIGNAL = '#2ae07a'
const GREEN_PALE = '#c9ffe0'

// Green stand-in for the reference's indigo→purple→amber sweep.
const HEADLINE_GRADIENT = `linear-gradient(to left, ${GREEN_DEEP}, ${GREEN_SIGNAL}, ${GREEN_PALE})`

/** Module scope, not an inline literal: PlasmaWave rebuilds its context if the
 *  array's identity changes, and a fresh array every render would do that. */
const PLASMA_COLORS: [string, string] = [GREEN_SIGNAL, GREEN_DEEP]

/* The dot field behind the features, and the only place on this page where the
   accent is texture rather than signal. So it is one hue at two alphas, not two
   greens: `--accent` thinning along the diagonal. Both ends being the same
   colour is what keeps the section reading as one dim surface instead of as a
   gradient with an opinion, and the section already has a signal green in the
   eyebrow label and in the diagrams.

   Tuned down from 0.28/0.07. The number that decides this is not the copy,
   which wins easily, but the faintest thing in a FeatureDiagram: the dashed
   accent guides at 0.45 opacity, which measure 2.99:1 against --paper. At 0.28
   the brightest dot inside the content column measured 1.73:1, so a 3.5px disc
   was within 1.7x of the 1.5px line it sits behind, in the same hue. At 0.22 it
   measures 1.48:1, which is a 2.0x margin there, 3.3x to the diagram's base
   ink, and 4.5x to the body copy, while still reading as a clear texture. */
const DOTS_FROM = 'rgba(42, 224, 122, 0.22)'
const DOTS_TO = 'rgba(42, 224, 122, 0.06)'

/*
  What sits between the plasma and the closing headline. Three layers painted
  in this order, top first, each with exactly one job.

  The pool is centred on the headline rather than on the section, and it is
  wide (96%) and shallow, because the thing that has to stay legible is one
  line of type running most of the width. Centring it on the section instead
  put its weakest edge exactly on the ends of that line, which is where a
  contrast measurement goes to fail. Pooling over the words and thinning by the
  time it reaches the button is also the better picture: the ribbons come out
  brightest where they frame the CTA and are quietest behind the copy.

  The feather hides the section's own top and bottom edges, so the field
  arrives and leaves instead of being switched on at a border.

  The flat wash underneath both is the floor. It is sized for a plasma pixel
  that comes out white, which the shader's channel crosstalk can produce at the
  core of a streak, rather than for the green the field is mostly made of. That
  is not a hypothetical: the brightest pixel the field puts under this headline
  measures rgb(229 255 255).

  Measured, so nobody trims it back. Over the headline's own glyph boxes the
  scrim's three layers combine to a total alpha that bottoms out at 0.646, and
  --ink on the worst pixel of a live field sampled across 320 frames reads
  5.98:1. The floor under that is not the shader's to move: force every pixel
  behind the headline to pure white and the same geometry still reads 5.6:1.
  This type is 32px to 51px, so the bar is 3.0:1 at AA and 4.5:1 even at AAA.
  There is real headroom. There is less of it than a desktop check suggests.

  Because the worst case is a viewport around 480 to 570 CSS px, and that is
  the trap. The radial is sized in percentages of a section whose proportions
  change with the window: wide, the headline is a small target in the middle of
  a large pool (alpha 0.75 and 8.6:1 at 1920), and narrow, the same line runs
  nearly the full width and reaches the pool's weakest edge. Any measurement
  taken on one screen is a measurement of that screen. Check the small end
  before changing a number in here.
*/
const CLOSING_SCRIM = [
  'radial-gradient(96% 52% at 50% 36%, rgb(var(--paper) / 0.72), transparent 80%)',
  'linear-gradient(to bottom, rgb(var(--paper)), transparent 22%, transparent 78%, rgb(var(--paper)))',
  'rgb(var(--paper) / 0.5)',
].join(',')

// `to` is a route, `href` an anchor on this page. Join is the only one of the
// first kind, and it is here because the board's join screen had no way in
// from the marketing page at all: you could be read a code and have nowhere
// to type it.
const NAV: { label: string; href?: string; to?: string }[] = [
  { label: 'Features', href: '#features' },
  { label: 'Demo', href: '#demo' },
  { label: 'Assistant', href: '#assistant' },
  { label: 'Join by code', to: '/join' },
]

function NavItem({ item, className }: { item: (typeof NAV)[number]; className: string }) {
  return item.to ? (
    <Link to={item.to} className={className}>
      {item.label}
    </Link>
  ) : (
    <a href={item.href} className={className}>
      {item.label}
    </a>
  )
}

interface Feature {
  diagram: DiagramName
  title: string
  body: string
}

// Two bands, because there are two jobs and they happen in order: you put a
// shape down, then you move it. The old grid was six equal cards, which said
// the six were interchangeable, and they are not: Formations is the one people
// come for and it leads its band at twice the size.
const SHAPING: Feature[] = [
  {
    diagram: 'formations',
    title: 'Formations',
    body: 'Ten shapes for eleven-a-side, plus sets for 7-a-side and futsal. Numbers follow the roles, so your 6 sits where a 6 sits. Mid-block and high-line versions of each.',
  },
  {
    diagram: 'assistant',
    title: 'The assistant',
    body: 'Type what you want and the board does it. No account, no network. It reads your words on the machine you are sat at.',
  },
  {
    diagram: 'canvas',
    title: 'Room to think',
    body: 'The pitch has edges. The canvas around it does not, so you can park a set piece off to one side and come back to it later.',
  },
]

const MOVING: Feature[] = [
  {
    diagram: 'frames',
    title: 'Frames',
    body: 'Capture a position. Move people. Capture again. Scrub back through it, or export the whole move as a GIF or a clip.',
  },
  {
    diagram: 'rooms',
    title: 'Rooms',
    body: 'Boards live at a URL. Send it on and someone else is looking at the same pitch.',
  },
  {
    diagram: 'sharing',
    title: 'Sharing',
    body: 'The address bar is the share link. Nobody has to sign up to look at what you made.',
  },
]

// Shapes the board ships with — honest marquee content, not invented clients.
const SHAPES = ['4-3-3', '4-2-3-1', '3-5-2', '4-4-2', '5-3-2', '4-1-4-1', '3-4-3', '4-3-2-1']

/**
 * The one thing the page is asking for, in the two places it asks.
 *
 * The specular rim is the page's single moment of spectacle, and it is spent
 * here rather than spread across six cards, because this is the only control
 * that matters. The focus outline stays even though SpecularButton lights the
 * whole edge on focus-visible: the rim is WebGL and can decline to exist, and
 * a focus indicator that depends on a graphics context is not one.
 */
function OpenBoardCta() {
  return (
    <Magnetic>
      <ClickSpark>
        <SpecularButton>
          <Link
            to="/board"
            className="liquid-glass inline-flex items-center gap-2 rounded-full px-[29px] py-[24px]
              text-[15px] font-medium leading-none text-foreground transition-colors duration-200
              hover:bg-[var(--accent-wash)] focus-visible:outline focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Open the board
            <span aria-hidden>→</span>
          </Link>
        </SpecularButton>
      </ClickSpark>
    </Magnetic>
  )
}

/**
 * The quiet way in, for whoever was read a code instead of sent a link.
 *
 * The ink is /75 rather than /45 because at 12px this has to clear 4.5:1, and
 * the closing instance sits over the plasma: a bright streak passing under it
 * took the /45 value down to 1.94:1. The scrim was tuned for the headline,
 * which is far larger, so this line needs the contrast in the ink itself.
 */
function JoinByCodeLink({ className = '' }: { className?: string }) {
  return (
    <Link
      to="/join"
      className={`font-mono text-[12px] tracking-[0.08em] text-foreground/75 underline-offset-4
        transition-colors duration-200 hover:text-accent hover:underline focus-visible:outline
        focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent
        ${className}`}
    >
      Or join with a code
    </Link>
  )
}

function Navbar() {
  const signedIn = useAuthStore((s) => s.email)

  return (
    <div className="relative">
      <nav className="flex w-full items-center justify-between px-8 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" width={26} height={26} className="shrink-0" />
          <span className="font-display text-[19px] font-semibold tracking-[-0.02em] text-foreground">
            FootyBoard
          </span>
          <span className="hidden font-mono text-[10px] tracking-[0.14em] text-accent sm:inline">
            TACTICS
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <NavItem
              key={item.label}
              item={item}
              className="text-[14px] text-foreground/90 transition-colors duration-200
                hover:text-accent focus-visible:outline focus-visible:outline-2
                focus-visible:outline-offset-4 focus-visible:outline-accent"
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {signedIn ? (
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.1em] text-foreground/50 sm:inline">
              {signedIn}
            </span>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-full px-3 py-2 text-[14px] text-foreground/80 transition-colors
                  duration-200 hover:text-accent focus-visible:outline focus-visible:outline-2
                  focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Log in
              </Link>
              <Link
                to="/signup"
                className="liquid-glass rounded-full px-4 py-2 text-[14px] font-medium text-foreground
                  transition-colors duration-200 hover:bg-[var(--accent-wash)]
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-accent"
              >
                Sign up
              </Link>
            </>
          )}
          <Link
            to="/board"
            className="rounded-full bg-accent px-4 py-2 text-[14px] font-medium text-paper
              transition-colors duration-200 hover:bg-accent-hover
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-accent"
          >
            Open board
          </Link>
        </div>
      </nav>

      {/* Hairline under the bar, brightest in the middle. */}
      <div className="mt-[3px] h-px w-full bg-gradient-to-r from-transparent via-foreground/20 to-transparent" />
    </div>
  )
}

function ShapeMarquee() {
  return (
    <div className="mx-auto w-full max-w-5xl px-8 pb-10">
      <div className="flex flex-col items-center gap-8 sm:flex-row sm:gap-12">
        <p className="shrink-0 text-center text-sm leading-5 text-foreground/50 sm:text-left">
          Shapes you can drop
          <br className="hidden sm:block" /> straight in
        </p>

        <div className="relative w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
          <div className="flex w-max animate-[marquee_20s_linear_infinite] gap-16 motion-reduce:animate-none">
            {[...SHAPES, ...SHAPES].map((shape, i) => (
              <div key={`${shape}-${i}`} className="flex shrink-0 items-center gap-3">
                <span className="liquid-glass grid h-6 w-6 place-items-center rounded-lg font-mono text-[11px] text-accent">
                  {shape[0]}
                </span>
                <span className="text-base font-semibold text-foreground">{shape}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A band's name, sitting on the hairline that separates it from the band
 * above. This is the section's whole grouping mechanism now, which is why it
 * is a rule rather than a heading: it draws the line between the two halves
 * without pretending to be a third level of headline.
 */
function BandRule({ children }: { children: ReactNode }) {
  return (
    <Reveal className="mb-10 flex items-center gap-5">
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.2em] text-foreground/45">
        {children}
      </span>
      <span className="h-px flex-1 bg-rule" />
    </Reveal>
  )
}

export default function LandingPage() {
  const heroRef = useRef<HTMLElement>(null)

  // Scroll-linked hero hand-off: the copy drifts up and dims while the
  // backdrop trails behind it, so the section leaves deliberately rather than
  // just sliding under the fold. Transform and opacity only — both composited.
  //
  // MotionConfig cannot help here: these are motion values wired straight to
  // style, not animations, so nothing suppresses them. Two layers moving at
  // different speeds is the definition of parallax, which is the one thing
  // reduced motion is most clearly asking for less of, so the travel is what
  // goes. The fade stays, because a fade has no direction to disagree with.
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const copyY = useTransform(scrollYProgress, [0, 1], ['0%', reduced ? '0%' : '-40%'])
  const copyOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0])
  const backdropY = useTransform(scrollYProgress, [0, 1], ['0%', reduced ? '0%' : '16%'])

  return (
    <div className="relative min-h-screen overflow-hidden bg-paper">
      <ScrollProgress />
      <motion.div style={{ y: backdropY }} className="absolute inset-0">
        <FloodlitBackdrop />
        <TacticalLoop className="pointer-events-none absolute inset-0 h-screen w-full opacity-70" />
      </motion.div>

      <div className="relative z-10">
        <section ref={heroRef} className="flex min-h-screen flex-col overflow-visible">
          <Navbar />

          <div className="relative flex flex-1 items-center justify-center px-6">
            {/* Blurred mass that lets the headline sit on the backdrop. */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-[527px] w-[984px]
                max-w-[130vw] -translate-x-1/2 -translate-y-1/2 bg-gray-950 opacity-90 blur-[82px]"
            />

            <motion.div
              style={{ y: copyY, opacity: copyOpacity }}
              className="relative flex flex-col items-center text-center"
            >
              {/* The ceiling is in rem so the headline still answers to the
                  browser's text size. In px it did not, and the page had two
                  behaviours: section heads below that scaled, a hero that did
                  not. Tracking tightens as the type grows, which is the whole
                  reason one fixed value cannot serve a 220px display and a
                  29px section head. */}
              <h1
                className="font-display font-normal leading-[1.02] tracking-[-0.035em]
                  text-[clamp(4.25rem,17vw,13.75rem)]"
              >
                <span className="text-foreground">Total </span>
                <span
                  className="bg-clip-text text-transparent"
                  style={{ backgroundImage: HEADLINE_GRADIENT }}
                >
                  Football
                </span>
              </h1>

              <p className="mt-[9px] max-w-md text-lg leading-8 text-hero-sub opacity-80">
                Two teams, a pitch, and nothing in the way. Set the shape, move it, send the link.
              </p>

              <div className="mt-[25px] flex flex-col items-center gap-[18px]">
                <OpenBoardCta />
                <JoinByCodeLink />
              </div>
            </motion.div>
          </div>

          <ShapeMarquee />
        </section>

        {/* Features */}
        <section
          id="features"
          className="relative border-t border-rule/60 bg-paper/80 backdrop-blur-sm"
        >
          {/* Above the section's own translucent paint, below its content.
              Both stacking positions are explicit and positive: a negative
              z-index against an element that carries a backdrop-filter puts
              the layer behind the blur rather than in front of it. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <DotField
              glow={false}
              gradientFrom={DOTS_FROM}
              gradientTo={DOTS_TO}
              dotRadius={3.5}
              dotSpacing={23}
              cursorRadius={400}
              cursorForce={0.39}
              bulgeOnly
              bulgeStrength={51}
              sparkle
              waveAmplitude={14}
            />
          </div>

          <div className="relative z-10 mx-auto max-w-6xl px-8 py-24">
            <Reveal className="mb-3 font-mono text-[12px] uppercase tracking-[0.18em] text-accent">
              What it does
            </Reveal>
            <Reveal
              delay={0.05}
              className="mb-14 max-w-2xl font-display text-[clamp(1.8rem,4vw,2.9rem)] font-normal
                leading-[1.06] tracking-[-0.015em]"
            >
              What a coach actually needs, and not much else.
            </Reveal>

            {/* Band one. The rule and its label are the only grouping device
                left; the cards lost their borders because six boxes drawn the
                same size is the thing that made them look interchangeable. */}
            <BandRule>Getting a shape down</BandRule>

            <div className="grid gap-x-14 gap-y-14 lg:grid-cols-2">
              <Reveal>
                <FeatureDiagram name={SHAPING[0].diagram} className="w-full max-w-[480px]" />
                <h3 className="mt-8 font-display text-[26px] font-normal leading-tight tracking-[-0.02em]">
                  {SHAPING[0].title}
                </h3>
                <p className="mt-3 max-w-md text-[15px] leading-relaxed text-foreground/60">
                  {SHAPING[0].body}
                </p>
              </Reveal>

              <div className="flex flex-col justify-center gap-11">
                {SHAPING.slice(1).map((f, i) => (
                  <Reveal key={f.title} delay={0.05 + i * 0.05}>
                    {/* Side by side once there is room. Below sm the text
                        column would be squeezed to about 120px, which is four
                        words a line. */}
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
                      <FeatureDiagram name={f.diagram} className="w-[168px] shrink-0" />
                      <div>
                        <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{f.title}</h3>
                        <p className="mt-2 text-[14px] leading-relaxed text-foreground/60">{f.body}</p>
                      </div>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>

            {/* Band two. Three equal moves, so three equal cells. */}
            <div className="mt-24">
              <BandRule>And moving it</BandRule>
            </div>

            <div className="grid gap-x-12 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
              {MOVING.map((f, i) => (
                <Reveal key={f.title} delay={i * 0.05}>
                  <FeatureDiagram name={f.diagram} className="w-full max-w-[288px]" />
                  <h3 className="mt-7 text-[16px] font-semibold tracking-[-0.01em]">{f.title}</h3>
                  <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-foreground/60">{f.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Live board */}
        <LiveBoardSection />

        {/* Assistant */}
        <section id="assistant" className="border-t border-rule/60">
          <div className="mx-auto max-w-3xl px-8 py-24 text-center">
            <Reveal className="mb-3 font-mono text-[12px] uppercase tracking-[0.18em] text-accent">
              Offline assistant
            </Reveal>
            <Reveal
              delay={0.05}
              className="font-display text-[clamp(1.8rem,4vw,2.9rem)] font-normal leading-[1.06] tracking-[-0.015em]"
            >
              Say the shape. The board builds it.
            </Reveal>
            <Reveal delay={0.1} className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-foreground/60">
              Type it the way you'd say it on the grass. It runs on your device, so it still works
              with the wifi off.
            </Reveal>

            <Reveal delay={0.15} className="mt-10">
              <div className="liquid-glass mx-auto max-w-lg rounded-lg p-5 text-left">
                <p className="font-mono text-[13px] leading-relaxed text-foreground/80">
                  <span className="text-accent">&gt;</span> put the away team in a 4-2-3-1 mid block
                </p>
                <p className="mt-3 border-t border-foreground/10 pt-3 text-[13px] leading-relaxed text-foreground/60">
                  Set the away team up in a 4-2-3-1 mid block.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Closing. The one WebGL field on the page, and the last screen. */}
        <section className="relative overflow-hidden border-t border-rule/60">
          <PlasmaWave
            className="absolute inset-0"
            colors={PLASMA_COLORS}
            speed1={0.04}
            speed2={0.03}
            focalLength={0.9}
          />
          <div aria-hidden className="absolute inset-0" style={{ background: CLOSING_SCRIM }} />

          <div className="relative mx-auto max-w-6xl px-8 py-32 text-center">
            <Reveal className="mx-auto mb-8 max-w-2xl font-display text-[clamp(2rem,4.6vw,3.2rem)] font-normal leading-[1.04] tracking-[-0.015em]">
              Open a pitch and show the idea.
            </Reveal>
            <Reveal delay={0.1} className="flex flex-col items-center gap-[18px]">
              <OpenBoardCta />
              <JoinByCodeLink />
            </Reveal>
          </div>
        </section>

        <footer className="border-t border-rule/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-8 py-9 sm:flex-row">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[16px] font-semibold tracking-[-0.02em]">
                FootyBoard
              </span>
              <span className="font-mono text-[10px] tracking-[0.14em] text-accent">TACTICS</span>
            </div>
            <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] text-foreground/40">
              {NAV.map((item) => (
                <NavItem key={item.label} item={item} className="transition-colors hover:text-accent" />
              ))}
              <Link to="/privacy" className="transition-colors hover:text-accent">
                Privacy
              </Link>
              <Link to="/terms" className="transition-colors hover:text-accent">
                Terms
              </Link>
            </nav>
            <span className="font-mono text-[11px] tracking-[0.08em] text-foreground/40">
              © 2026
            </span>
          </div>
        </footer>
      </div>
    </div>
  )
}

function LiveBoardSection() {
  const [codes, setCodes] = useState({ home: '4-3-3', away: '4-4-2' })

  return (
    <section id="demo" className="border-t border-rule/60">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-8 py-24 lg:grid-cols-[0.85fr,1.15fr]">
        <div>
          <Reveal className="mb-3 font-mono text-[12px] uppercase tracking-[0.18em] text-accent">
            Live on the board
          </Reveal>
          <Reveal
            delay={0.05}
            className="font-display text-[clamp(1.8rem,4vw,2.9rem)] font-normal leading-[1.06] tracking-[-0.015em]"
          >
            Move a back line, watch it settle.
          </Reveal>
          <Reveal delay={0.1} className="mt-5 max-w-md text-[15px] leading-relaxed text-foreground/60">
            Chips travel to where you put them, so you see the movement and not just the result.
            Capture frames as you go, then play the whole thing back.
          </Reveal>
        </div>

        <Reveal delay={0.1} y={28}>
          <div className="liquid-glass overflow-hidden rounded-lg">
            <div className="flex items-center justify-between border-b border-foreground/10 px-4 py-2.5">
              <span className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] text-foreground/50">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                LIVE
              </span>
              <span className="flex items-center gap-3 font-mono text-[11px] text-foreground/70 tabular-nums">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-home" />
                  {codes.home}
                </span>
                <span className="text-foreground/30">vs</span>
                <span className="flex items-center gap-1.5">
                  {codes.away}
                  <span className="h-2 w-2 rounded-full bg-away" />
                </span>
              </span>
            </div>
            <div className="bg-black/40 p-3">
              <MiniPitch className="w-full" onCycle={setCodes} />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
