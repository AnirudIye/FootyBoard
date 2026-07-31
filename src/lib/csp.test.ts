import { describe, it, expect } from 'vitest'

import { DOCUMENT_CSP } from './csp.js'

// Read through Vite's own `?raw` rather than `node:fs`. This file sits under
// `src`, which is typechecked by tsconfig.app.json with `types: ["vite/client"]`
// and no node types, and adding them here would loosen the whole app to get at
// three config files.
import viteConfigSource from '../../vite.config.ts?raw'
import serverEntrySource from '../../server/src/index.js?raw'
import vercelConfigSource from '../../vercel.json?raw'

/**
 * Three things deliver this policy, and they have to stay one policy.
 *
 * `vite.config.ts` injects it as a `<meta>` tag so the built output is never
 * unprotected; `vercel.json` sends it as a real header because a `<meta>` CSP
 * silently ignores `frame-ancestors`, which is the directive clickjacking
 * protection actually rests on; and `server/src/index.js` sends it when
 * `SERVE_STATIC=true` makes that process the origin. None can be dropped: the
 * tag covers a host that forgets the header, the header covers what the tag
 * cannot express, and the server is the only one of the three present on a
 * self-hosted deploy.
 *
 * **This file used to compare two copies by regex, and the third delivery was
 * added without it noticing.** The API served `dist/` under its own
 * `default-src 'none'`, so the page loaded with its own scripts forbidden and
 * nothing failed anywhere. Two of the three import the policy from
 * `src/lib/csp.js` now, so they cannot disagree; `vercel.json` is JSON, can
 * import nothing, and is the one copy still kept in step by hand. That is what
 * the first test below is for.
 *
 * The other two tests are about the imports staying imports. A re-declared
 * literal would pass a value comparison on the day it was written and drift
 * afterwards, which is exactly how this got here.
 */

interface VercelHeader {
  key: string
  value: string
}
interface VercelRule {
  source: string
  headers: VercelHeader[]
}

const vercelConfig = JSON.parse(vercelConfigSource) as { headers: VercelRule[] }

function policyFromVercelJson(): string {
  const csp = vercelConfig.headers
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === 'Content-Security-Policy')
  if (!csp) throw new Error('vercel.json sends no Content-Security-Policy header')
  return csp.value
}

describe('content security policy', () => {
  it('is the same policy in vercel.json as in the module the other two import', () => {
    expect(policyFromVercelJson()).toBe(DOCUMENT_CSP)
  })

  it('sends the header on every path, not just the document', () => {
    expect(vercelConfig.headers.map((rule) => rule.source)).toContain('/(.*)')
  })

  it('carries the directive the meta tag cannot express', () => {
    // The whole reason the header exists. A `<meta>` CSP drops frame-ancestors
    // without complaining, so losing it here loses it everywhere.
    expect(policyFromVercelJson()).toContain("frame-ancestors 'none'")
  })

  it('has the meta tag import the policy rather than restate it', () => {
    expect(viteConfigSource).toMatch(/import \{ DOCUMENT_CSP \} from '\.\/src\/lib\/csp\.js'/)
    // A re-declared array is the shape the drift came in last time.
    expect(viteConfigSource).not.toMatch(/const CSP = \[/)
  })

  it('has the API import the document policy, so SERVE_STATIC serves a usable page', () => {
    // The regression this file exists for. Without this import the API sends
    // `default-src 'none'` on index.html and the app never boots, while every
    // status code and content type stays correct.
    expect(serverEntrySource).toMatch(/import \{ DOCUMENT_CSP \} from '\.\.\/\.\.\/src\/lib\/csp\.js'/)
    expect(serverEntrySource).toMatch(/DOCUMENT_CSP/)
  })
})

function hstsFromVercelJson(): string {
  const hsts = vercelConfig.headers
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === 'Strict-Transport-Security')
  if (!hsts) throw new Error('vercel.json sends no Strict-Transport-Security header')
  return hsts.value
}

/**
 * The header with no second copy anywhere.
 *
 * The CSP has the `<meta>` tag to fall back on, so a `vercel.json` that lost it
 * would still ship something. This one has no `<meta>` form, nothing in the
 * built output mentions it, and `verify:deployed` can only see it after a
 * deploy has already happened. So this file is the only place its removal can
 * be caught beforehand.
 *
 * It asserts the number rather than the header's presence because `max-age=0`
 * is not a weaker header: it is the instruction to drop the pin, and a browser
 * that has been told once will honour it.
 */
describe('strict transport security', () => {
  it('is declared, with a max-age that pins rather than forgets', () => {
    const maxAge = Number(hstsFromVercelJson().match(/max-age\s*=\s*(\d+)/i)?.[1] ?? NaN)
    expect(maxAge).toBeGreaterThan(0)
  })
})
