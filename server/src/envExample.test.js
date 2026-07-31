import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The placeholder is written down twice, and this is what stops that mattering.
 *
 * `env.js` refuses to boot production on the exact string `.env.example` ships,
 * which means it has to know that string, which means there are two copies of
 * it. Every other duplication in this repo has eventually drifted, and the
 * failure here would be the quiet kind: change the placeholder in
 * `.env.example`, and the check in `env.js` goes on matching a value nobody uses
 * any more. It would still throw on the length floor today, and that is luck
 * rather than design, because a longer placeholder would sail through a check
 * written to catch exactly it.
 *
 * So the two are asserted equal, the same way `src/lib/csp.test.ts` holds
 * `vercel.json` and the injected `<meta>` tag to one string.
 */

const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/** The value of one `KEY=value` line, or null if the key is absent. */
function valueOf(text, key) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`))
  return line === undefined ? null : line.slice(key.length + 1).trim()
}

test('the placeholder env.js refuses is the one .env.example actually ships', async () => {
  const [example, env] = await Promise.all([read('../.env.example'), read('./env.js')])

  const shipped = valueOf(example, 'SESSION_SECRET')
  assert.ok(shipped, '.env.example no longer sets SESSION_SECRET at all')

  assert.ok(
    env.includes(`'${shipped}'`),
    `env.js does not refuse the placeholder .env.example ships (${shipped}), so a production ` +
      'deploy carrying it would boot with a public secret.',
  )
})

/**
 * The same drift, on the connection string.
 *
 * `env.js` falls back to the local database when `DATABASE_URL` is unset, and
 * `.env.example` writes that same database down a second time. The failure if
 * they part company is quiet and total: change the port or the role in one of
 * them and every suite in this directory stops being able to connect, with
 * nothing anywhere saying which of the two spellings is the one being used.
 */
test('the database env.js falls back to is the one .env.example ships', async () => {
  const [example, env] = await Promise.all([read('../.env.example'), read('./env.js')])

  const shipped = valueOf(example, 'DATABASE_URL')
  assert.ok(shipped, '.env.example no longer sets DATABASE_URL at all')

  assert.ok(
    env.includes(`'${shipped}'`),
    `env.js does not fall back to the database .env.example ships (${shipped}), so the two ` +
      'have drifted and the suite is connecting somewhere the documentation does not name.',
  )
})

/**
 * The floor is only a floor if the placeholder is under it. Both checks exist
 * because either one alone has a hole: the exact-match arm catches a long
 * placeholder, and the length arm catches a short secret somebody invented.
 */
test('the shipped placeholder is also under the length floor', async () => {
  const [example, env] = await Promise.all([read('../.env.example'), read('./env.js')])

  const shipped = valueOf(example, 'SESSION_SECRET')
  const floor = Number(env.match(/MIN_SECRET_LENGTH = (\d+)/)?.[1])

  assert.ok(Number.isInteger(floor), 'MIN_SECRET_LENGTH is no longer a literal in env.js')
  assert.ok(
    shipped.length < floor,
    `the placeholder (${shipped.length} chars) is at or above the floor (${floor}), so the two ` +
      'checks no longer overlap and one of them is doing nothing.',
  )
})

/**
 * `ENCRYPTION_KEY` must ship empty rather than filled in. A committed value
 * there would be worse than the session placeholder: it is the key real boards
 * are sealed with, and anyone copying the file into production would encrypt
 * every board under a key published in this repository.
 */
test('.env.example ships no encryption key at all', async () => {
  const example = await read('../.env.example')
  assert.equal(valueOf(example, 'ENCRYPTION_KEY'), '')
})

/** Same argument, and the one that would cost money rather than secrecy. */
test('.env.example ships no Gemini key', async () => {
  const example = await read('../.env.example')
  assert.equal(valueOf(example, 'GEMINI_API_KEY'), '')
})
