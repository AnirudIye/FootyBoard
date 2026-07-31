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
 * What no test in this repo can see is whether the headers are being **sent**.
 * `vercel.json` is read by Vercel and by nothing else, so moving host, renaming
 * the file, or deploying the built output from somewhere else silently stops
 * them applying, and nothing anywhere fails. That matters more than it sounds
 * for each of the two headers checked here, and for different reasons:
 *
 *   - A `<meta>` CSP **silently ignores** `frame-ancestors`, so the tag is not a
 *     fallback for that directive. When the header goes, clickjacking protection
 *     on the app goes with it, invisibly. The API's own `X-Frame-Options: DENY`
 *     covers the API and says nothing about the page.
 *   - **HSTS has no `<meta>` form at all**, so there is no second copy to fall
 *     back on and nothing in the built output that even mentions it. Without it,
 *     somebody who types the bare domain, or follows an old `http://` link, makes
 *     one plaintext request that can be answered by whoever is on the network
 *     path — and that request carries the session cookie unless it happens to be
 *     the very first one. The API sends its own HSTS on its own responses; this
 *     is the document origin, which is a different host and a different config.
 *
 * So: fetch the deployed origin and fail if either header is missing, if
 * `frame-ancestors 'none'` is not in the policy, if the HSTS `max-age` is zero
 * or absent, or if either no longer matches what `vercel.json` says it should
 * be. Run it after every deploy, and treat a host migration as a security change
 * that has to pass this by hand first.
 *
 *   node scripts/check-deployed-headers.mjs https://your-deployment
 *
 * Exits 0 when both headers are being served and match, 1 otherwise.
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

/**
 * What `vercel.json` says a header should be, so this cannot drift from it.
 *
 * One reader for both headers rather than one function per header: the way a
 * check like this stops working is somebody adding a third header and a third
 * near-copy of this that looks in a slightly different place.
 *
 * A header `vercel.json` does not declare at all throws rather than being
 * skipped. Silently passing when there is nothing to compare against is how a
 * deleted header becomes a green check.
 */
function declaredHeader(config, name) {
  const header = config.headers
    ?.flatMap((rule) => rule.headers ?? [])
    .find((h) => h.key.toLowerCase() === name)

  if (!header) throw new Error(`vercel.json declares no ${name} header at all.`)
  return header.value
}

const configPath = fileURLToPath(new URL('../vercel.json', import.meta.url))
const config = JSON.parse(await readFile(configPath, 'utf8'))

const expectedPolicy = declaredHeader(config, 'content-security-policy')
const expectedHsts = declaredHeader(config, 'strict-transport-security')

const fail = (message) => {
  console.error(`FAIL  ${message}`)
  process.exitCode = 1
}

let response
try {
  // `redirect: 'follow'` is the default and is what we want: the headers have to
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

/* -------------------------------------------------------------------------- */
/* Content-Security-Policy                                                     */
/* -------------------------------------------------------------------------- */

const servedPolicy = response.headers.get('content-security-policy')

if (!servedPolicy) {
  fail(
    'no content-security-policy RESPONSE HEADER. The <meta> tag is not a substitute: a meta CSP ' +
      "silently ignores frame-ancestors, so the app can be framed. If the host is no longer " +
      'Vercel, vercel.json is not being read and the policy has to be configured on the new host.',
  )
} else {
  if (!servedPolicy.includes(REQUIRED_DIRECTIVE)) {
    fail(
      `the policy is served but does not contain ${REQUIRED_DIRECTIVE}.\n      served: ${servedPolicy}`,
    )
  }

  if (servedPolicy.trim() !== expectedPolicy.trim()) {
    fail(
      'the served policy is not the one vercel.json declares, so the deployed build is not this ' +
        `commit or the host is rewriting it.\n      expected: ${expectedPolicy}\n      served:   ${servedPolicy}`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Strict-Transport-Security                                                   */
/* -------------------------------------------------------------------------- */

const servedHsts = response.headers.get('strict-transport-security')

if (!servedHsts) {
  fail(
    'no strict-transport-security RESPONSE HEADER. Unlike the CSP there is no <meta> fallback for ' +
      'this one and nothing in the built output mentions it, so this is the only place it can be ' +
      'caught. Without it the first request to the bare domain, and every follow of an old http ' +
      'link, is a plaintext request somebody on the network path can answer. If the host is no ' +
      'longer Vercel, vercel.json is not being read and this has to be set on the new host.',
  )
} else {
  /**
   * `max-age=0` is not a weaker header, it is the instruction to **forget** the
   * pin. A check that only asked whether the header was present would pass on a
   * deploy that had actively turned the protection off, which is the one state
   * worth catching most.
   */
  const maxAge = Number(servedHsts.match(/max-age\s*=\s*"?(\d+)"?/i)?.[1] ?? NaN)

  if (!Number.isFinite(maxAge) || maxAge === 0) {
    fail(
      'strict-transport-security is served with no usable max-age, which tells browsers to drop ' +
        `the pin rather than to hold it.\n      served: ${servedHsts}`,
    )
  }

  if (servedHsts.trim() !== expectedHsts.trim()) {
    fail(
      'the served HSTS header is not the one vercel.json declares, so the deployed build is not ' +
        `this commit or the host is rewriting it.\n      expected: ${expectedHsts}\n      served:   ${servedHsts}`,
    )
  }
}

if (process.exitCode === 1) process.exit(1)

console.log(`OK    content-security-policy is served and matches vercel.json`)
console.log(`OK    ${REQUIRED_DIRECTIVE} is in effect`)
console.log(`OK    strict-transport-security is served and matches vercel.json`)
