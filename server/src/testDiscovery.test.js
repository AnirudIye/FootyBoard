import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

/**
 * Which files `node --test` will pick up, asserted rather than assumed.
 *
 * `npm --prefix server test` is a bare `node --test`, so the runner decides what
 * a test is by **matching filenames**, and its patterns are wider than the one
 * this project uses. `**\/*-test.?(c|m)js` is in the default set, so
 * `scripts/load-test.mjs` — a command-line tool that connects to a host and
 * exits non-zero when it is not given credentials — was discovered as a test
 * file and failed the whole suite from the day it was added. It was already in
 * the mirror before anybody ran the suite again.
 *
 * The failure is nasty in a specific way: the suite reports one failure among
 * three hundred passes, at a path that is obviously not a test, and the obvious
 * reading is that something is wrong with the script rather than with where it
 * lives. Nothing about the name looks dangerous until you know the glob.
 *
 * So the rule is stated here instead of remembered: **a file the runner would
 * discover has to be a `.test.js` under `src/`.** Anything else with a matching
 * name is a script that is about to be executed by the test runner.
 *
 * This file claims no port. It reads the tree and nothing else.
 */

const serverDir = fileURLToPath(new URL('..', import.meta.url))

/** Node's default test-file patterns, as of the runner this suite runs on. */
const DISCOVERED = [
  /\.test\.[cm]?js$/,
  /-test\.[cm]?js$/,
  /_test\.[cm]?js$/,
  /(^|[\\/])test-[^\\/]*\.[cm]?js$/,
  /(^|[\\/])test\.[cm]?js$/,
]

/** Directories the runner itself ignores, or that hold no source. */
const SKIP = new Set(['node_modules', 'data', '.git'])

const walk = (dir, found = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, found)
    else found.push(relative(serverDir, full))
  }
  return found
}

test('every file the test runner discovers is a test file under src/', () => {
  const discovered = walk(serverDir).filter((path) => DISCOVERED.some((re) => re.test(path)))

  // A path that matches the glob but is not one of ours is a script the runner
  // is about to execute. Rename it; the npm script that calls it can keep its
  // own name, since that is not what the runner reads.
  const strays = discovered.filter(
    (path) => !(path.startsWith(`src${sep}`) && path.endsWith('.test.js')),
  )

  assert.deepEqual(
    strays,
    [],
    `these are not tests, and \`node --test\` will run them: ${strays.join(', ')}`,
  )

  // And the walk has to have found something, or this passes by looking at
  // nothing at all.
  assert.ok(discovered.length > 20, `expected the suite's own files, found ${discovered.length}`)
})
