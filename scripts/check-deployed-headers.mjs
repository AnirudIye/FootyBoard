#!/usr/bin/env node
/**
 * The check that has to live outside the test suite, because it is about the
 * host rather than about the code.
 *
 * This is the whole of known gap 1. The app's Content-Security-Policy is written
 * in two places on purpose: a `<meta>` tag injected at build time by the
 * `footyboard-csp` plugin in `vite.config.ts`, and a real response header in
 * `vercel.json`. `src/lib/csp.test.ts` already holds those two to the same
 * string, so drift between them fails in CI.
 *
 * What no test in this repo can see is whether the header is being **sent**.
 * `vercel.json` is read by Vercel and by nothing else, so moving host, renaming
 * the file, or deploying the built output from somewhere else silently stops the
 * header applying, and nothing anywhere fails. That matters more than it sounds:
 * a `<meta>` CSP **silently ignores** `frame-ancestors`, so the tag is not a
 * fallback for this directive. When the header goes, clickjacking protection on
 * the app goes with it, invisibly. The API's own `X-Frame-Options: DENY` covers
 * the API and says nothing about the page.
 *
 * So: fetch the deployed origin and fail if the header is missing, if
 * `frame-ancestors 'none'` is not in it, or if it no longer matches what
 * `vercel.json` says it should be. Run it after every deploy, and treat a host
 * migration as a security change that has to pass this by hand first.
 *
 *   node scripts/check-deployed-headers.mjs https://your-deployment
 *
 * Exits 0 when the policy is being served and matches, 1 otherwise.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const REQUIRED_DIRECTIVE = "frame-ancestors 'none'"

const origin = process.argv[2] ?? process.env.DEPLOY_URL

if (!origin) {
  console.error(
    'Usage: node scripts/check-deployed-headers.mjs <origin>\n' +
      '   or: DEPLOY_URL=https://... node scripts/check-deployed-headers.mjs',
  )
  process.exit(1)
}

/** What `vercel.json` says the policy should be, so this cannot drift from it. */
async function expectedPolicy() {
  const path = fileURLToPath(new URL('../vercel.json', import.meta.url))
  const config = JSON.parse(await readFile(path, 'utf8'))
  const header = config.headers
    ?.flatMap((rule) => rule.headers ?? [])
    .find((h) => h.key.toLowerCase() === 'content-security-policy')

  if (!header) {
    throw new Error('vercel.json declares no Content-Security-Policy header at all.')
  }
  return header.value
}

const fail = (message) => {
  console.error(`FAIL  ${message}`)
  process.exitCode = 1
}

const expected = await expectedPolicy()

let response
try {
  // `redirect: 'follow'` is the default and is what we want: the header has to
  // be on the document people actually receive, not on a redirect to it.
  response = await fetch(origin, { redirect: 'follow' })
} catch (err) {
  fail(`could not reach ${origin}: ${err.message}`)
  process.exit(1)
}

console.log(`GET ${response.url} -> ${response.status}`)

if (!response.ok) {
  fail(`the origin answered ${response.status}, so this proves nothing about a working deploy.`)
}

const served = response.headers.get('content-security-policy')

if (!served) {
  fail(
    'no content-security-policy RESPONSE HEADER. The <meta> tag is not a substitute: a meta CSP ' +
      "silently ignores frame-ancestors, so the app can be framed. If the host is no longer " +
      'Vercel, vercel.json is not being read and the policy has to be configured on the new host.',
  )
  process.exit(1)
}

if (!served.includes(REQUIRED_DIRECTIVE)) {
  fail(`the policy is served but does not contain ${REQUIRED_DIRECTIVE}.\n      served: ${served}`)
}

if (served.trim() !== expected.trim()) {
  fail(
    'the served policy is not the one vercel.json declares, so the deployed build is not this ' +
      `commit or the host is rewriting it.\n      expected: ${expected}\n      served:   ${served}`,
  )
}

if (process.exitCode === 1) process.exit(1)

console.log(`OK    content-security-policy is served and matches vercel.json`)
console.log(`OK    ${REQUIRED_DIRECTIVE} is in effect`)
