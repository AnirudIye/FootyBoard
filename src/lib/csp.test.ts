import { describe, it, expect } from 'vitest'

// Read through Vite's own `?raw` rather than `node:fs`. This file sits under
// `src`, which is typechecked by tsconfig.app.json with `types: ["vite/client"]`
// and no node types, and adding them here would loosen the whole app to get at
// two config files.
import viteConfigSource from '../../vite.config.ts?raw'
import vercelConfigSource from '../../vercel.json?raw'

/**
 * The policy is written twice and has to stay one policy.
 *
 * `vite.config.ts` injects it as a `<meta>` tag so the built output is never
 * unprotected, and `vercel.json` sends it as a real header because a `<meta>`
 * CSP silently ignores `frame-ancestors`, which is the directive clickjacking
 * protection actually rests on. Neither can be dropped: the tag covers a host
 * that forgets the header, and the header covers what the tag cannot express.
 *
 * Two copies of a security control is how one of them quietly stops matching.
 * This repo has already shipped that failure several times, most recently a
 * team colour that drifted from its own token while a comment claimed they
 * matched. So the drift is asserted rather than trusted to review.
 */

/** The array literal in vite.config.ts, joined the way the plugin joins it. */
function policyFromViteConfig(): string {
  const block = viteConfigSource.match(/const CSP = \[([\s\S]*?)\]\.join\('; '\)/)
  if (!block) throw new Error('could not find the CSP array in vite.config.ts')
  return [...block[1].matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]).join('; ')
}

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
  it('is the same policy in the meta tag and the Vercel header', () => {
    expect(policyFromVercelJson()).toBe(policyFromViteConfig())
  })

  it('sends the header on every path, not just the document', () => {
    expect(vercelConfig.headers.map((rule) => rule.source)).toContain('/(.*)')
  })

  it('carries the directive the meta tag cannot express', () => {
    // The whole reason the header exists. A `<meta>` CSP drops frame-ancestors
    // without complaining, so losing it here loses it everywhere.
    expect(policyFromVercelJson()).toContain("frame-ancestors 'none'")
  })
})
