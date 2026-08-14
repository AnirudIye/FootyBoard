/**
 * The words the marketing pages are made of, in the one place both renderers
 * can read them.
 *
 * There are two renderers now, which is the whole reason this file exists.
 * `LandingPage.tsx` draws these with React in a browser, and
 * `scripts/prerender.mjs` writes them into static HTML at build time for the
 * crawlers that never run any of it. Two copies of the same sentence maintained
 * by hand is the drift this repo has already been bitten by — see the
 * `text-away` cursor in `FeatureDiagram.tsx`, which asserted for weeks that it
 * matched a colour it had never matched.
 *
 * **Plain `.js` in a TypeScript project, deliberately, and not the first.**
 * `src/lib/csp.js` is the precedent and the reason is identical: a Node script
 * with no build step has to be able to `import` this, and it cannot import
 * `.ts`. The app imports it just as happily.
 *
 * **Nothing here may describe the product more generously than the product
 * behaves.** The static half of this is what a crawler reads, so a sentence
 * added here that the page does not also show is cloaking rather than
 * marketing. Anything added here has to be added to what the user sees, or not
 * added.
 */

/**
 * The hero.
 *
 * `headline` is one string even though the page paints "Football" in a gradient
 * across a second `<span>`: a prerendered `<h1>` wants the sentence, not the
 * typography, and splitting it here would put a layout decision in a content
 * file. `LandingPage.tsx` does the splitting, because that is where the
 * gradient is.
 */
export const HERO = {
  headline: 'Total Football',
  sub: 'Two teams, a pitch, and nothing in the way. Set the shape, move it, send the link.',
}

/**
 * The sign-up page, which is a page now rather than a form on its own.
 *
 * It used to answer `noindex`, along with every other route with no prerendered
 * copy, and that was right while it *had* no copy: it served the home page's
 * document, so indexing it would have been indexing a duplicate. A page with its
 * own words is a different question, and this is the answer to it.
 *
 * **`sub` and `gives` are rendered by `AuthPage` as well as by the prerender**,
 * which is the whole point and is not optional. This file's header says a
 * sentence the page does not also show is cloaking rather than marketing, and
 * five of the seven existing pages currently put a summary line in the static
 * body that the React tree never says — see `handoff.md`. This one does not join
 * them: every sentence below is on the page a person sees, in these words.
 *
 * The three in `gives` are what an account actually changes, checked against the
 * code rather than written as benefits. Boards save (a signed-out visitor's
 * board is never written anywhere), the payload is encrypted before it is
 * stored, and sharing is a link or a six-letter code into a live room. Nothing
 * about verification or recovery is here: that belongs beside the fields it is
 * about, and the form already says it.
 */
export const SIGNUP = {
  heading: 'Create an account',
  sub: 'An account is what keeps your boards. Save as many as you like, open them from any machine, and hand one to somebody else with a link.',
  gives: [
    'Your boards save as you work, and are encrypted before they are stored.',
    'Share a board by link or by a six-letter code, and everyone in the room moves the same players at the same time.',
    'It is free, there is nothing to install, and a board opens in a browser.',
  ],
}

/**
 * The first band: putting a shape down.
 *
 * Shape is `{ diagram, title, body }` and matches what `LandingPage.tsx`
 * already fed its `Feature` interface, so the component's own type still
 * describes these and the import was a one-line change. `diagram` names a
 * drawing the prerender has no use for and ignores; it is here because the two
 * bands are one list with one shape, and splitting the fields by which renderer
 * wants them would be two lists to keep in step instead of one.
 */
export const SHAPING = [
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

/** The second band: moving it. */
export const MOVING = [
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

/**
 * Every address worth arriving at, and what its `<title>` and description
 * should say.
 *
 * **This is the fix for a real defect, not a nicety.** Express serves one
 * `index.html` for every route, so until now `/privacy` and `/board` and `/`
 * were three URLs carrying one identical title and one identical description.
 * That is the exact shape a search engine reads as three copies of one
 * document, and `sitemap.xml` was busy asking it to index all three. The
 * comment in `index.html` names this as outstanding work; this is it.
 *
 * `file` is where the prerender writes each one. `/` keeps `index.html`
 * because that name is also the server's fallback for everything unlisted, so
 * an address nobody thought of still gets a real page rather than a 404.
 *
 * `body` is the static prose written inside `#root`, and it is deliberately
 * absent for the app routes. `/board` renders a canvas; there is no honest
 * paragraph to put there, and inventing one to feed a crawler is the thing this
 * file's header forbids.
 */
export const PAGES = [
  {
    path: '/',
    file: 'index.html',
    title: 'FootyBoard: free online soccer tactics board',
    description:
      'FootyBoard is an animated, collaborative soccer tactics board. Open a pitch, pick a formation, and move players in seconds.',
    heading: HERO.headline,
    body: [HERO.sub],
    features: [...SHAPING, ...MOVING],
  },
  {
    path: '/board',
    file: 'board.html',
    title: 'The board: FootyBoard',
    description:
      'An animated soccer tactics board. Pick a formation, drag players, draw the movement, and share the board with a link.',
  },
  {
    path: '/signup',
    file: 'signup.html',
    title: 'Create a free account: FootyBoard',
    description:
      'Create a free FootyBoard account to save your soccer tactics boards, open them from any machine, and share one with a link or a six-letter code.',
    heading: SIGNUP.heading,
    body: [SIGNUP.sub, ...SIGNUP.gives],
  },
  {
    path: '/join',
    file: 'join.html',
    title: 'Join a board: FootyBoard',
    description: 'Open a shared FootyBoard with the six-letter code somebody read out to you.',
    heading: 'Join a board',
    // The sentence `JoinPage` already showed as its subtitle, moved here rather
    // than paraphrased. The static document used to say "Enter the six-letter
    // code you were given to open the board it belongs to" — the same idea in
    // different words, which is two sentences to maintain and one of them
    // invisible to everybody who is not a crawler.
    body: ['Enter the six-letter code from whoever is running the session.'],
  },
  {
    path: '/privacy',
    file: 'privacy.html',
    title: 'Privacy Policy: FootyBoard',
    description: 'What FootyBoard stores, why it stores it, and how to have it deleted.',
    heading: 'Privacy Policy',
    body: ['What FootyBoard stores, why it stores it, and how to have it deleted.'],
  },
  {
    path: '/terms',
    file: 'terms.html',
    title: 'Terms of Service: FootyBoard',
    description: 'The terms you agree to by using FootyBoard.',
    heading: 'Terms of Service',
    body: ['The terms you agree to by using FootyBoard.'],
  },
  {
    path: '/accessibility',
    file: 'accessibility.html',
    title: 'Accessibility: FootyBoard',
    description:
      'How FootyBoard is built to be usable with a keyboard, a screen reader, and reduced motion.',
    heading: 'Accessibility',
    body: [
      'How FootyBoard is built to be usable with a keyboard, a screen reader, and reduced motion.',
    ],
  },
  {
    path: '/contact',
    file: 'contact.html',
    title: 'Contact: FootyBoard',
    description: 'How to reach FootyBoard about deletion, copyright, or anything else.',
    heading: 'Contact',
    body: ['How to reach FootyBoard about deletion, copyright, or anything else.'],
  },
]

/**
 * The one-line summary a page opens with, for the component that has to show it.
 *
 * **This exists because five pages were cloaking and nobody could see it.**
 * `/join`, `/privacy`, `/terms`, `/accessibility` and `/contact` each had a
 * `body` line written into their static document by `scripts/prerender.mjs`, and
 * the React tree said none of them — so a crawler read a sentence no visitor was
 * ever shown. That is the exact thing this file's header forbids, and it had
 * been true since the day the prerender shipped.
 *
 * The fix is not to delete the sentences: a legal page opening with one line
 * saying what it is, before three thousand words of clauses, is better for the
 * person reading it than a wall that starts at clause one. So the pages show
 * them now, and this is how they get them — from `PAGES`, which is the same
 * place the prerender reads, so the two cannot say different things.
 *
 * Derived rather than a second list, and derived *by path*, so a page added to
 * `PAGES` with a body and no lede on screen is the only way back into the
 * defect — which `marketing.cloaking.test.tsx` is what closes.
 */
export const ledeFor = (path) => PAGES.find((page) => page.path === path)?.body ?? []
