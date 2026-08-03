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

      // `strip:` is "the frame strip has room for the whole of itself on one
      // line". It is a fourth variant rather than more `roomy:` because the
      // frame strip is roughly three times the width of either toolbar, so the
      // width at which it stops fitting is nowhere near 640 — and `roomy` was
      // measured to be the wrong answer for it.
      //
      // The strip is the widest bar in the product: at three captured frames it
      // measures 920px, and every further frame adds a chip. It was one
      // non-wrapping row centred in the viewport inside a page that is
      // `overflow-hidden`, and what that cost was not a squeeze, it was the
      // feature. At 375x812 with a single frame captured the bar spanned -236 to
      // 611: `+ Frame`, `GIF` and `Video` were all off screen with nothing to
      // scroll, so a phone could capture one frame, could not capture a second,
      // and a GIF needs two. A 768px tablet lost `+ Frame` at one frame and
      // `GIF` at two.
      //
      // **1280 rather than "wide enough for the bar", and the difference is the
      // assistant's launcher.** The bar is centred, so it needs its own width
      // plus twice whatever must stay clear at one end. The launcher is
      // `fixed bottom-4 right-4` and 105px wide, so it owns 121px of the right
      // edge — and a centred bar reaches it as soon as it is wider than the
      // window less 242. At three frames the bar is 920px under a mouse and
      // 976px under a finger, which puts the crossing at 1162 and 1218.
      //
      // 1024 was tried first and measured wrong for exactly that reason: a
      // 1024x768 tablet showed the whole 976px bar and the launcher sat on top
      // of `Video`, so the bar fitted the screen and still could not be used.
      // Below 1280 the strip shows what a sequence is *built, checked and sent*
      // with — `+ Frame`, `Play`, `GIF` — which holds it to one line and 329px
      // on a phone, well clear of the corner.
      //
      // Width alone, and no height clause, because this is a horizontal bar and
      // the axis it runs out of is horizontal. That happens to catch 812x375
      // landscape as well, which needs it for the same reason every other phone
      // orientation does.
      //
      // **A long enough sequence still overruns above 1280, and this does not
      // fix that.** Every captured frame adds a chip, so around twelve frames on
      // a 1440px desktop the bar reaches the launcher again. `flex-wrap` on the
      // bar keeps it on the screen; nothing here keeps it out from under the
      // launcher, because no breakpoint can — the bar's width is a function of
      // how many frames somebody captured, not of the window.
      addVariant('strip', '@media (min-width: 1280px)')
    }),
  ],
} satisfies Config
