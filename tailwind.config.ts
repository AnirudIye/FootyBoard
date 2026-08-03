import type { Config } from 'tailwindcss'
import plugin from 'tailwindcss/plugin'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
        rule: 'rgb(var(--rule) / <alpha-value>)',
        'rule-strong': 'rgb(var(--rule-strong) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
        'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
        foreground: 'rgb(var(--ink) / <alpha-value>)',
        'hero-sub': 'rgb(var(--hero-sub) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--accent-hover) / <alpha-value>)',
        home: 'rgb(var(--home) / <alpha-value>)',
        away: 'rgb(var(--away) / <alpha-value>)',
        // The save indicator's alarm. Not a team, despite having been --home.
        alert: 'rgb(var(--alert) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"Geist Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', '"Geist Sans"', 'ui-sans-serif', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        DEFAULT: 'var(--r-md)',
        lg: 'var(--r-lg)',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      // `touch:` is the input device, not the screen, and that distinction is
      // the whole reason it is a variant rather than a `screens` entry: a
      // 1280px-wide tablet needs the large targets and a 380px-wide desktop
      // window does not. Width breakpoints stay for layout — what is on screen
      // and how it wraps. This governs size only.
      //
      // Nearly all of the sizing is one floor in `index.css` rather than a
      // class per control. This variant is for the handful of places where the
      // floor is the wrong shape and a component has to say so itself.
      addVariant('touch', '@media (pointer: coarse)')

      // `roomy:` is "there is room for the whole bar", and it replaced a bare
      // `sm:` on the two toolbars because width alone was answering the wrong
      // question. A phone turned sideways is 812x375: wide enough to clear
      // `sm`, so both bars unfolded to their full desktop selves — and 375px
      // tall, so at 44px targets the top bar took 181px of a 375px screen and
      // the pitch was left 124px with the bench rails sitting across the
      // drawing bar. The bar has room when it is both wide enough for the
      // controls and tall enough for the board underneath them.
      addVariant('roomy', '@media (min-width: 640px) and (min-height: 520px)')

      // `overlay:` is "the board's chrome floats over the pitch", and its
      // absence is "the chrome is docked in a column under it". It is a third
      // variant rather than more `roomy:` because it answers a third question,
      // and answering it with `roomy` was measured to be wrong.
      //
      // Three conditions float it, and each is a separate reason:
      //
      // - **`(pointer: fine)`** — a mouse. Docking exists to stop the bench
      //   rails standing on the goalmouths, and on a desktop the pair costs
      //   about 8% of a wide canvas with the nets still reachable around it.
      //   This clause is also what makes the change provably free on desktop:
      //   every `overlay:` rule is live there, so the layout is the one that
      //   shipped.
      // - **`(max-height: 639px)`** — no room underneath. A phone held sideways
      //   is 812x375, and the docked chrome wants about 164px of a 188px band:
      //   keyed on `roomy` this screen docked and was left with **24px of
      //   canvas**, against 188 before. Landscape needs its chrome beside the
      //   pitch, which is the mirror image of the portrait argument — at 812
      //   wide the drawn pitch is 358px across and the empty canvas is
      //   horizontal, so the rails are already standing on nothing.
      // - **`(min-width: 900px)`** — the pitch is not short of width. Docking
      //   pays only where the drawn pitch is width-constrained, because that is
      //   the axis the rails eat. On a 1024x768 tablet the pair covers 11% of
      //   the canvas and docking would take the pitch from 921x597 to 693x449,
      //   which is paying a quarter of the board to recover an eighth of it.
      //
      // So it docks on exactly the screens the complaint was about: a phone or
      // a tablet held upright, where the rails cover 18.5% of the drawn pitch
      // and both goalmouths, and where the empty canvas is vertical and free.
      addVariant('overlay', '@media (pointer: fine), (max-height: 639px), (min-width: 900px)')
    }),
  ],
} satisfies Config
