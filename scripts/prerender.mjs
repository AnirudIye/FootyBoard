#!/usr/bin/env node
/**
 * Give every marketing route a page a crawler can read, and its own title.
 *
 * The problem, measured rather than assumed. On 2026-08-03 the body served to
 * Googlebot was, in full:
 *
 *     <body>
 *       <div id="root"></div>
 *     </body>
 *
 * Every word on this site is drawn by React in the browser. Google renders
 * JavaScript, eventually, on a second pass it schedules when it feels like it;
 * nothing else does. The AI crawlers do not, which is the half that matters
 * most here, because a product whose whole pitch is "send someone the link"
 * lives or dies on being describable by an assistant somebody asked for a
 * tactics board. And the second defect is quieter: Express answers `/privacy`,
 * `/board` and `/` with the same file, so those were three URLs wearing one
 * identical `<title>` and one identical description. That is the shape a search
 * engine reads as three copies of one document, while `sitemap.xml` asked it to
 * index all three.
 *
 * **What this is not.** It is not SSR and does not run the app. `LandingPage`
 * reaches framer-motion, WebGL and Konva, none of which survive Node, and a
 * headless browser to render six mostly-static pages is a dependency and a
 * class of flake bought for nothing. It writes the same sentences the component
 * writes, from `src/content/marketing.js`, which is why that file exists and why
 * the component imports from it too.
 *
 * **What it must never become.** The static body is what a crawler reads and
 * the React tree is what a person reads, so a sentence that appears in one and
 * not the other is cloaking. Everything written here comes from the shared
 * content module, and anything added to it has to be added to the page.
 *
 * `main.tsx` uses `createRoot().render()`, not `hydrateRoot`, so React discards
 * whatever is inside `#root` on its first paint. That is what makes this safe
 * to put there: the static copy is a placeholder React overwrites, not a tree it
 * will try to reconcile and complain about.
 *
 *   node scripts/prerender.mjs [distDir]
 *
 * Exits 0 on success, 1 if the shell is missing or a page came out empty.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PAGES } from '../src/content/marketing.js'

const dist = process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url))
const ORIGIN = 'https://www.footyboard.me'

/**
 * Escape before interpolating, because this is writing HTML from data.
 *
 * The content module is ours and holds no angle brackets today, which is
 * exactly the reasoning that makes the omission survive review and then stop
 * being true the day somebody writes "5-a-side <> 11-a-side" in a feature body.
 * Cheap here, unfixable once it has shipped into a cache.
 */
const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * Replace the content of a `<meta>` whose name or property is `key`.
 *
 * Anchored on the tag rather than on the old value: matching the string that is
 * already there means this quietly does nothing the day somebody edits
 * `index.html`, and doing nothing is indistinguishable from having worked.
 */
function setMeta(html, attr, key, value) {
  const pattern = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[^"]*(")`, 'i')
  if (!pattern.test(html)) {
    // The multi-line form Prettier produces for the long ones.
    const spread = new RegExp(`(<meta\\s*\\n\\s*${attr}="${key}"\\s*\\n\\s*content=")[^"]*(")`, 'i')
    if (!spread.test(html)) return { html, ok: false }
    return { html: html.replace(spread, `$1${escape(value)}$2`), ok: true }
  }
  return { html: html.replace(pattern, `$1${escape(value)}$2`), ok: true }
}

/**
 * The static body for one page.
 *
 * Styled inline and minimally, in the palette `index.html`'s `theme-color`
 * already declares. Not because a crawler cares — it does not — but because a
 * person on a slow connection now sees this for the moment before the bundle
 * arrives, where they used to see a blank page. Unstyled black-on-white for
 * that moment would be a worse first paint than the nothing it replaces, which
 * would make this a regression dressed as an improvement.
 */
function staticBody(page) {
  const parts = []

  if (page.heading) parts.push(`<h1>${escape(page.heading)}</h1>`)
  for (const line of page.body ?? []) parts.push(`<p>${escape(line)}</p>`)

  for (const feature of page.features ?? []) {
    parts.push(`<section><h2>${escape(feature.title)}</h2><p>${escape(feature.body)}</p></section>`)
  }

  if (parts.length === 0) return ''

  return (
    `<div style="max-width:46rem;margin:0 auto;padding:4rem 1.5rem;` +
    `font-family:system-ui,sans-serif;background:#080a09;color:#e8eae9;min-height:100vh">` +
    parts.join('') +
    `</div>`
  )
}

/* -------------------------------------------------------------------------- */

const shellPath = join(dist, 'index.html')

let shell
try {
  shell = await readFile(shellPath, 'utf8')
} catch (err) {
  console.error(`FAIL  no build to prerender into: ${shellPath}\n      ${err.message}`)
  console.error('      Run `vite build` first; this runs after it, not instead of it.')
  process.exit(1)
}

if (!shell.includes('<div id="root"></div>')) {
  console.error(
    'FAIL  the built index.html has no empty <div id="root"></div> to write into.\n' +
      '      Either the shell changed or this has already run against this dist.',
  )
  process.exit(1)
}

let failed = false

for (const page of PAGES) {
  let html = shell

  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escape(page.title)}</title>`)

  for (const [attr, key, value] of [
    ['name', 'description', page.description],
    ['property', 'og:title', page.title],
    ['property', 'og:description', page.description],
    ['property', 'og:url', `${ORIGIN}${page.path}`],
  ]) {
    const result = setMeta(html, attr, key, value)
    if (!result.ok) {
      console.error(`FAIL  ${page.path}: no <meta ${attr}="${key}"> in the shell to rewrite.`)
      failed = true
    }
    html = result.html
  }

  /**
   * The canonical, which `index.html` deliberately does not carry.
   *
   * Its comment explains why: one file served at every path means one absolute
   * canonical would tell Google that `/board` and `/join` are duplicates of the
   * home page and drop them. That reasoning was right and is now spent — each
   * page below is a separate file and can carry its own, which is the thing the
   * comment said needed the server to do per path.
   */
  html = html.replace(
    '</head>',
    `  <link rel="canonical" href="${ORIGIN}${page.path}" />\n  </head>`,
  )

  const body = staticBody(page)
  if (body) html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`)

  await writeFile(join(dist, page.file), html, 'utf8')

  const words = body.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length
  console.log(`  ${page.file.padEnd(20)} ${page.path.padEnd(16)} ${words} words`)
}

if (failed) {
  console.error('\nFAIL  at least one tag could not be rewritten, so some pages are duplicates.')
  process.exit(1)
}

console.log(`\nOK    ${PAGES.length} pages prerendered into ${dist}`)
