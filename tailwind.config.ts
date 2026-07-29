import type { Config } from 'tailwindcss'

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
  plugins: [],
} satisfies Config
