#!/usr/bin/env node
/**
 * The second check that has to live outside the test suite, for the same reason
 * as `check-deployed-headers.mjs`: it is about the host, and no test in this
 * repo can see the host.
 *
 * On 2026-08-03 this site answered **403 to every AI crawler** — GPTBot,
 * OAI-SearchBot, ClaudeBot, PerplexityBot — while answering 200 to Googlebot and
 * Bingbot. Nothing in this repo caused it and nothing in this repo could have
 * caught it. The request never reached Express: the body was `Your request was
 * blocked.`, and the response carried `X-Frame-Options: SAMEORIGIN` where the
 * app sends `DENY`, and no CSP at all where the app always sends one. That is
 * Cloudflare's "Block AI bots" toggle answering at the edge, on a zone setting a
 * person clicked once and nobody can see from here.
 *
 * Why that is worth a script rather than a note. The failure is invisible from
 * every angle a developer normally looks from: the site loads in a browser, it
 * loads for Googlebot, the deploy is green, and the tests pass. The only symptom
 * is an absence — the product never gets cited by an assistant, and there is no
 * log line anywhere for a thing that did not happen. A toggle nobody can see,
 * whose failure mode is silence, is exactly the shape of thing that needs one
 * command to interrogate it.
 *
 * **This checks reachability, not indexing.** A 200 here means the crawler can
 * fetch the document. It says nothing about whether there are any words in that
 * document once fetched — this app renders every word client-side, so a crawler
 * that does not run JavaScript gets `<div id="root"></div>` and no content
 * whatever this script reports. Unblocking is necessary and not sufficient; the
 * prerender is the other half.
 *
 *   node scripts/check-crawler-access.mjs https://www.footyboard.me
 *   npm run verify:crawlers
 *
 * Exits 0 when every crawler below can fetch both the document and robots.txt,
 * 1 otherwise.
 */

const origin = (process.argv[2] ?? process.env.DEPLOY_URL ?? '').replace(/\/+$/, '')

if (!origin) {
  console.error(
    'Usage: node scripts/check-crawler-access.mjs <origin>\n' +
      '   or: DEPLOY_URL=https://... node scripts/check-crawler-access.mjs',
  )
  process.exit(1)
}

/**
 * The crawlers worth knowing about, and the string each one identifies itself
 * with.
 *
 * **Only the token matters.** Cloudflare's bot rules, and every other blocklist
 * that does this, match on the product token — `GPTBot`, `ClaudeBot` — rather
 * than on the whole string. So these drifting out of date as operators bump a
 * version is harmless: the match still lands, and the check still tells the
 * truth. They are written out in full anyway because a bare token is not a
 * user-agent and some middleboxes treat one as a malformed request.
 *
 * `search` and `ai` are separated because the two groups fail for different
 * reasons and mean different things. A blocked Googlebot is an emergency and
 * almost certainly a mistake. A blocked GPTBot is usually somebody's deliberate
 * policy — it is only a bug here because this project wants the citations.
 */
const CRAWLERS = [
  {
    tier: 'search',
    name: 'Googlebot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/140.0.0.0 Safari/537.36',
  },
  {
    tier: 'search',
    name: 'bingbot',
    ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  },
  {
    tier: 'search',
    name: 'DuckDuckBot',
    ua: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  },
  {
    tier: 'ai',
    name: 'GPTBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
  },
  {
    // The one that answers a live ChatGPT search, as opposed to GPTBot which
    // gathers training data. Blocking one and not the other is a real and
    // common configuration, so they are checked separately rather than assumed
    // to move together.
    tier: 'ai',
    name: 'OAI-SearchBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  },
  {
    tier: 'ai',
    name: 'ClaudeBot',
    ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  },
  {
    tier: 'ai',
    name: 'PerplexityBot',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
  },
  {
    tier: 'ai',
    name: 'Applebot',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  },
]

/**
 * Where the answer came from, which is the whole diagnostic value of this file.
 *
 * The app sends a `Content-Security-Policy` header on every response it serves
 * — `vercel.json` on Vercel, and the API itself when `SERVE_STATIC=true` makes
 * it the origin. Cloudflare's block page sends none. So a response with no CSP
 * is a response the origin never saw, and that single bit is the difference
 * between "fix this in the Cloudflare dashboard" and "fix this in this repo",
 * which is otherwise an afternoon of looking in the wrong place.
 */
function answeredBy(response) {
  return response.headers.get('content-security-policy') ? 'origin' : 'edge'
}

async function probe(path, ua) {
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: { 'user-agent': ua },
      redirect: 'follow',
    })
    return { status: response.status, from: answeredBy(response) }
  } catch (err) {
    return { status: 0, from: 'unreachable', error: err.message }
  }
}

console.log(`Probing ${origin} as ${CRAWLERS.length} crawlers\n`)

const results = []

for (const crawler of CRAWLERS) {
  // Sequential rather than concurrent, and deliberately so: eight parallel
  // requests wearing eight different bot user-agents is itself the traffic
  // pattern a bot-protection rule exists to catch, and a check that trips the
  // thing it is measuring is worse than no check.
  const document = await probe('/', crawler.ua)
  const robots = await probe('/robots.txt', crawler.ua)
  results.push({ ...crawler, document, robots })
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const width = Math.max(...CRAWLERS.map((c) => c.name.length))
const cell = ({ status, from }) => `${status || '---'} (${from})`

for (const tier of ['search', 'ai']) {
  console.log(tier === 'search' ? 'Search crawlers' : '\nAI crawlers')

  for (const r of results.filter((r) => r.tier === tier)) {
    const ok = r.document.status === 200 && r.robots.status === 200
    console.log(
      `  ${ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(width)}  ` +
        `/ ${cell(r.document)}   /robots.txt ${cell(r.robots)}`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* What robots.txt actually says once the edge has finished with it            */
/* -------------------------------------------------------------------------- */

/**
 * A 200 on `/robots.txt` is not the same as `public/robots.txt` being what gets
 * served, and on this host it is not what gets served.
 *
 * Cloudflare's managed robots.txt **prepends its own block** to the file this
 * repo ships, so the served document is the concatenation of two files that
 * were written by two authors who never saw each other's work. That is invisible
 * from the repo, invisible from the deploy, and changes what every crawler is
 * told.
 *
 * Two distinct things go wrong, and neither is unconditionally a bug:
 *
 *   - The managed block adds `Disallow: /` for a list of AI agents and a
 *     `Content-Signal` reserving training rights. Whether that is wanted is a
 *     policy question, so it is reported and not failed.
 *   - It opens with its own `User-agent: *` group. The file then has **two**,
 *     and robots.txt has no merge semantics for that — a crawler picks one
 *     group and ignores the other, so one author's rules are silently dropped.
 *
 * **The second check reads the repo's group rather than asserting what is in
 * it, and that is a correction rather than a refinement.** It used to fail with
 * "the repo's group carries the Disallow rules for /login, /reset, /2fa and the
 * rest of the account paths". Those rules were deleted on 2026-08-13, when
 * `X-Robots-Tag: noindex` replaced them — a `Disallow` asks a crawler not to
 * *fetch*, which is not what anybody wanted — and this script went on naming
 * them for two days. So it printed a red `FAIL`, and exited 1, over the loss of
 * a group that now holds a no-op `Allow: /` and a `Sitemap:` line that no
 * precedence rule can touch, because `Sitemap` is not group-scoped.
 *
 * A check that cannot pass is worse than no check: it is the one people learn
 * to scroll past, and the next real failure scrolls past with it. So the
 * structural oddity is still reported every time, and the severity now depends
 * on whether the dropped group would actually cost anything — which means this
 * becomes a `FAIL` again by itself, without an edit, the day somebody puts a
 * real rule back in `public/robots.txt`.
 */
const servedRobots = await (async () => {
  try {
    const response = await fetch(`${origin}/robots.txt`, { redirect: 'follow' })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
})()

let robotsIsBroken = false

if (servedRobots) {
  console.log('\nrobots.txt as served')

  const managed = /# BEGIN Cloudflare Managed content([\s\S]*?)# END Cloudflare Managed Content/i
  const managedBlock = servedRobots.match(managed)?.[1]

  if (managedBlock) {
    /**
     * Walked line by line rather than matched with one regex over the block.
     *
     * The regex version of this was wrong and quietly so: a lazy
     * `User-agent:(\S+)[\s\S]*?Disallow:\s*\/` starts at Cloudflare's own
     * `User-agent: *` group, whose body is `Allow: /`, and runs on to the first
     * `Disallow: /` in the *next* agent's group. That agent is then inside a
     * match attributed to `*`, gets filtered out with it, and vanishes from the
     * count. It under-reported the blocklist by exactly one every time, which is
     * the worst way for a check like this to be wrong.
     */
    const disallowed = []
    let group = null

    for (const line of managedBlock.split('\n')) {
      const agent = line.match(/^\s*User-agent:\s*(\S+)/i)
      if (agent) {
        group = agent[1]
        continue
      }
      if (group && group !== '*' && /^\s*Disallow:\s*\/\s*$/i.test(line)) {
        disallowed.push(group)
        group = null
      }
    }

    console.log(
      `  WARN  Cloudflare prepends a managed block disallowing ${disallowed.length} agents:\n` +
        `        ${disallowed.join(', ')}\n` +
        '        This is a separate control from the 403s above and survives turning\n' +
        '        those off. Cloudflare dashboard -> AI Crawl Control -> managed robots.txt.',
    )

    const signal = servedRobots.match(/^Content-Signal:\s*(.+)$/m)?.[1]
    if (signal) {
      console.log(
        `  WARN  Content-Signal: ${signal.trim()}\n` +
          '        A rights reservation under EU DSM Article 4, added by the same\n' +
          '        feature. Keep it or drop it deliberately, but know it is there.',
      )
    }
  }

  const wildcardGroups = servedRobots.match(/^User-agent:\s*\*\s*$/gim)?.length ?? 0

  /**
   * What the repo's own `User-agent: *` group would cost if a crawler dropped it.
   *
   * `Sitemap` is deliberately not read here. It is a non-group directive —
   * file-scoped, not attached to any `User-agent` — so group precedence cannot
   * lose it, and counting it would resurrect exactly the false alarm this
   * replaced.
   */
  const groupRules = (text) => {
    const rules = []
    let inWildcard = false

    for (const line of text.split('\n')) {
      const agent = line.match(/^\s*User-agent:\s*(\S+)/i)
      if (agent) {
        inWildcard = agent[1] === '*'
        continue
      }
      if (!inWildcard) continue

      const rule = line.match(/^\s*(Disallow|Allow|Crawl-delay|Noindex):\s*(.*)$/i)
      if (rule) rules.push(`${rule[1]}: ${rule[2].trim()}`.trim())
    }

    return rules
  }

  // The managed block cut out first, so this reads the group this repository
  // actually wrote rather than Cloudflare's identically-named one.
  const repoGroup = groupRules(managedBlock ? servedRobots.replace(managed, '') : servedRobots)

  /**
   * The two that change nothing when they go missing: `Allow: /` restates the
   * default, and a `Disallow:` with an empty value means the same thing.
   */
  const consequential = repoGroup.filter((rule) => !/^(Allow:\s*\/|Disallow:)$/i.test(rule))

  if (wildcardGroups > 1 && consequential.length > 0) {
    robotsIsBroken = true
    console.error(
      `  FAIL  ${wildcardGroups} separate "User-agent: *" groups in one file, and the\n` +
        "        repo's group carries rules that would be lost with it:\n" +
        `        ${consequential.join(', ')}\n` +
        '        robots.txt has no rule for merging them; a crawler takes one group\n' +
        '        and drops the other, and the repo\'s is second.',
    )
  } else if (wildcardGroups > 1) {
    console.log(
      `  WARN  ${wildcardGroups} separate "User-agent: *" groups in one file, which\n` +
        '        costs nothing today and is worth knowing anyway. A crawler takes one\n' +
        "        group and drops the other; the repo's is second, and it holds only\n" +
        `        ${repoGroup.join(', ') || 'no rules at all'} — the default said out loud.\n` +
        '        The Sitemap: line is not group-scoped and survives either way.\n' +
        '        Put a real rule in public/robots.txt and this becomes a FAIL by\n' +
        '        itself, which is the point of reading the group rather than\n' +
        '        asserting what is in it.',
    )
  } else {
    console.log('  OK    one "User-agent: *" group, so no precedence ambiguity.')
  }
}

const blocked = results.filter((r) => r.document.status !== 200 || r.robots.status !== 200)

if (blocked.length === 0 && !robotsIsBroken) {
  console.log('\nOK    every crawler above can fetch the document and robots.txt.')
  console.log(
    '      Reachability only. Whether there are words in what they fetched is a\n' +
      '      separate question this script does not answer.',
  )
  process.exit(0)
}

if (blocked.length > 0) {
  console.error(`\nFAIL  ${blocked.length} of ${results.length} crawlers cannot fetch this site.`)
}

// Which advice to give depends entirely on who answered, so say it rather than
// making the reader infer it from a column.
if (blocked.some((r) => r.document.from === 'edge' || r.robots.from === 'edge')) {
  console.error(
    '\n      At least one block came from the EDGE, not from this app — the request\n' +
      '      never reached Express, so there is nothing in this repo to change.\n' +
      '      Cloudflare dashboard -> the footyboard.me zone -> Security -> Bots,\n' +
      '      and turn off "Block AI bots". Check Security -> WAF -> Custom rules\n' +
      '      too; a managed rule can block the same agents independently.',
  )
}

if (blocked.some((r) => r.document.from === 'origin' || r.robots.from === 'origin')) {
  console.error(
    '\n      At least one block came from the ORIGIN, which means this app refused\n' +
      '      it. That is a change in this repo, and a surprising one: nothing in\n' +
      '      server/src filters on user-agent today.',
  )
}

if (blocked.some((r) => r.tier === 'search')) {
  console.error(
    '\n      A SEARCH crawler is blocked. Treat that as an outage rather than as a\n' +
      '      preference — it is the path ordinary organic traffic arrives by.',
  )
}

process.exit(1)
