import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, useScroll, useTransform } from 'framer-motion'
import ScrollProgress from './ScrollProgress'
import HeroVideo from './HeroVideo'
import FloodlitBackdrop from './FloodlitBackdrop'
import TacticalLoop from './TacticalLoop'
import MiniPitch from './MiniPitch'
import { TacticalGlyph } from './TacticalGlyph'
import type { GlyphName } from './TacticalGlyph'
import { Reveal } from './fx/Reveal'
import { Magnetic } from './fx/Magnetic'
import { ClickSpark } from './fx/ClickSpark'
import { useAuthStore } from '../../store/authStore'

/**
 * Background film for the hero. Point this at your own clip (drop an .mp4 in
 * /public and use "/your-clip.mp4"); with it empty the floodlit backdrop
 * carries the section on its own.
 */
const HERO_VIDEO = ''

// Green stand-in for the reference's indigo→purple→amber sweep.
const HEADLINE_GRADIENT = 'linear-gradient(to left, #0f7a45, #2ae07a, #c9ffe0)'

const NAV: { label: string; href: string; caret?: boolean }[] = [
  { label: 'Features', href: '#features', caret: true },
  { label: 'Demo', href: '#demo' },
  { label: 'Assistant', href: '#assistant', caret: true },
]

const FEATURES: { glyph: GlyphName; tag: string; title: string; body: string }[] = [
  {
    glyph: 'formation',
    tag: 'PRESETS',
    title: 'Formations',
    body: 'Ten shapes for eleven-a-side, plus sets for 7-a-side and futsal. Numbers follow the roles, so your 6 sits where a 6 sits. Mid-block and high-line versions of each.',
  },
  {
    glyph: 'assistant',
    tag: 'ASSISTANT',
    title: 'The assistant',
    body: 'Type what you want and the board does it. No account, no network. It reads your words on the machine you are sat at.',
  },
  {
    glyph: 'frames',
    tag: 'FRAMES',
    title: 'Frames',
    body: 'Capture a position. Move people. Capture again. Scrub back through it, or export the whole move as a GIF or a clip.',
  },
  {
    glyph: 'collab',
    tag: 'ROOMS',
    title: 'Rooms',
    body: 'Boards live at a URL. Send it on and someone else is looking at the same pitch.',
  },
  {
    glyph: 'canvas',
    tag: 'CANVAS',
    title: 'Room to think',
    body: 'The pitch has edges. The canvas around it does not — park a set piece off to one side and come back to it later.',
  },
  {
    glyph: 'share',
    tag: 'SHARING',
    title: 'Sharing',
    body: 'The address bar is the share link. Nobody has to sign up to look at what you made.',
  },
]

// Shapes the board ships with — honest marquee content, not invented clients.
const SHAPES = ['4-3-3', '4-2-3-1', '3-5-2', '4-4-2', '5-3-2', '4-1-4-1', '3-4-3', '4-3-2-1']

function Caret() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 opacity-70" fill="none" aria-hidden>
      <path
        d="M6 9.5 L12 15.5 L18 9.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
            Soccerboard
          </span>
          <span className="hidden font-mono text-[10px] tracking-[0.14em] text-accent sm:inline">
            TACTICS
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="flex items-center gap-1 text-[14px] text-foreground/90 transition-colors
                duration-200 hover:text-accent"
            >
              {item.label}
              {item.caret && <Caret />}
            </a>
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

export default function LandingPage() {
  const heroRef = useRef<HTMLElement>(null)

  // Scroll-linked hero hand-off: the copy drifts up and dims while the
  // backdrop trails behind it, so the section leaves deliberately rather than
  // just sliding under the fold. Transform and opacity only — both composited.
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const copyY = useTransform(scrollYProgress, [0, 1], ['0%', '-40%'])
  const copyOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0])
  const backdropY = useTransform(scrollYProgress, [0, 1], ['0%', '16%'])

  return (
    <div className="relative min-h-screen overflow-hidden bg-paper">
      <ScrollProgress />
      <HeroVideo src={HERO_VIDEO} />
      <motion.div style={{ y: backdropY }} className="absolute inset-0">
        <FloodlitBackdrop />
        <TacticalLoop className="pointer-events-none absolute inset-0 h-screen w-full opacity-70" />
      </motion.div>

      <div className="relative z-10">
        <section ref={heroRef} className="flex min-h-screen flex-col overflow-visible">
          <Navbar />

          <div className="relative flex flex-1 items-center justify-center px-6">
            {/* Blurred mass that lets the headline sit on the footage. */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-[527px] w-[984px]
                max-w-[130vw] -translate-x-1/2 -translate-y-1/2 bg-gray-950 opacity-90 blur-[82px]"
            />

            <motion.div
              style={{ y: copyY, opacity: copyOpacity }}
              className="relative flex flex-col items-center text-center"
            >
              <h1
                className="font-display font-normal leading-[1.02] tracking-[-0.024em]
                  text-[clamp(4.25rem,17vw,220px)]"
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

              <Magnetic strength={0.3}>
                <ClickSpark>
                  <Link
                    to="/board"
                    className="liquid-glass mt-[25px] inline-flex items-center gap-2 rounded-full
                      px-[29px] py-[24px] text-[15px] font-medium leading-none text-foreground
                      transition-colors duration-200 hover:bg-[var(--accent-wash)]
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                      focus-visible:outline-accent"
                  >
                    Open the board
                    <span aria-hidden>→</span>
                  </Link>
                </ClickSpark>
              </Magnetic>
            </motion.div>
          </div>

          <ShapeMarquee />
        </section>

        {/* Features */}
        <section id="features" className="border-t border-rule/60 bg-paper/80 backdrop-blur-sm">
          <div className="mx-auto max-w-6xl px-8 py-24">
            <Reveal className="mb-3 font-mono text-[12px] uppercase tracking-[0.18em] text-accent">
              What it does
            </Reveal>
            <Reveal
              delay={0.05}
              className="mb-14 max-w-2xl font-display text-[clamp(1.8rem,4vw,2.9rem)] font-normal
                leading-[1.06] tracking-[-0.024em]"
            >
              What a coach actually needs, and not much else.
            </Reveal>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f, i) => (
                <Reveal key={f.tag} delay={i * 0.05}>
                  <div
                    className="liquid-glass group h-full rounded-lg p-6 transition-transform
                      duration-300 hover:-translate-y-1"
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <span className="text-accent transition-transform duration-300 group-hover:-translate-y-0.5">
                        <TacticalGlyph name={f.glyph} className="h-7 w-7" />
                      </span>
                      <span className="font-mono text-[10px] tracking-[0.16em] text-foreground/40">
                        {f.tag}
                      </span>
                    </div>
                    <h3 className="mb-1.5 text-[16px] font-semibold tracking-[-0.01em]">{f.title}</h3>
                    <p className="text-[14px] leading-relaxed text-foreground/60">{f.body}</p>
                  </div>
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
              className="font-display text-[clamp(1.8rem,4vw,2.9rem)] font-normal leading-[1.06] tracking-[-0.024em]"
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

        {/* Closing */}
        <section className="border-t border-rule/60">
          <div className="mx-auto max-w-6xl px-8 py-24 text-center">
            <Reveal className="mx-auto mb-8 max-w-2xl font-display text-[clamp(2rem,4.6vw,3.2rem)] font-normal leading-[1.04] tracking-[-0.028em]">
              Open a pitch and show the idea.
            </Reveal>
            <Reveal delay={0.1} className="flex justify-center">
              <Magnetic strength={0.3}>
                <ClickSpark>
                  <Link
                    to="/board"
                    className="liquid-glass inline-flex items-center gap-2 rounded-full px-[29px]
                      py-[24px] text-[15px] font-medium leading-none text-foreground
                      transition-colors duration-200 hover:bg-[var(--accent-wash)]
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                      focus-visible:outline-accent"
                  >
                    Open the board
                    <span aria-hidden>→</span>
                  </Link>
                </ClickSpark>
              </Magnetic>
            </Reveal>
          </div>
        </section>

        <footer className="border-t border-rule/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-8 py-9 sm:flex-row">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[16px] font-semibold tracking-[-0.02em]">
                Soccerboard
              </span>
              <span className="font-mono text-[10px] tracking-[0.14em] text-accent">TACTICS</span>
            </div>
            <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] text-foreground/40">
              {NAV.map((item) => (
                <a key={item.label} href={item.href} className="transition-colors hover:text-accent">
                  {item.label}
                </a>
              ))}
              <Link to="/privacy" className="transition-colors hover:text-accent">
                Privacy
              </Link>
              <Link to="/terms" className="transition-colors hover:text-accent">
                Terms
              </Link>
            </nav>
            <span className="font-mono text-[11px] tracking-[0.08em] text-foreground/40">
              RUNS OFFLINE · © 2026
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
            className="font-display text-[clamp(1.8rem,4vw,2.9rem)] font-normal leading-[1.06] tracking-[-0.024em]"
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
