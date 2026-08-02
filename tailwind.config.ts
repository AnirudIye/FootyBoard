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
    }),
  ],
} satisfies Config
