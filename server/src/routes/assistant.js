import { Router } from 'express'
import { askAssistant, assistantEnabled } from '../assistant.js'
import { run } from '../db.js'
import { consume } from '../rateLimit.js'
import { BadRequest } from '../validate.js'

/**
 * The assistant's AI fallback.
 *
 * Sign-in required, and rate limited per account rather than per IP: this route
 * spends money on someone else's API quota, so the limit should follow the
 * person, not the network they happen to be on.
 *
 * It also refuses to run without consent, and keeps the record of it. The panel
 * asks before it ever calls this, but a permission enforced only by the thing
 * asking for it is not enforced: the request is an ordinary authenticated POST
 * that anything can make, and the browser's answer lives in `localStorage`,
 * where it does not survive clearing site data and never reached the server
 * that is actually sending the message to Google. So the flag rides on the
 * request, its absence is a 400, and the grant is written down once.
 */

export const assistantRouter = Router()

const MAX_MESSAGE = 500
const MAX_BOARD = 4000

/** Whether the AI fallback is configured, so the client can stop asking. */
assistantRouter.get('/status', (_req, res) => res.json({ enabled: assistantEnabled() }))

assistantRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Sign in to use the assistant.' })
    if (!assistantEnabled())
      return res.status(503).json({ error: 'The assistant is running in offline mode.' })

    if (req.body?.consent !== true)
      throw new BadRequest(
        'Turn on the online assistant in the panel before sending anything to Google.',
        'consent',
      )

    // Recorded on the grant rather than on the outcome, and only the first
    // time: what is worth keeping is when this person agreed, not how many
    // messages followed.
    await run(
      `INSERT INTO assistant_consents (user_id, granted_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      req.user.id,
      new Date().toISOString(),
    )

    const message = String(req.body?.message ?? '').trim()
    if (!message) throw new BadRequest('Type something for the assistant.', 'message')
    if (message.length > MAX_MESSAGE)
      throw new BadRequest('That message is too long for the assistant.', 'message')

    await consume(`assistant:${req.user.id}`, {
      max: 30,
      windowMs: 10 * 60 * 1000,
      message: 'You have asked the assistant a lot in a short time. Give it a minute.',
    })

    const context = {
      formationNames: Array.isArray(req.body?.formationNames)
        ? req.body.formationNames.slice(0, 40).map((n) => String(n).slice(0, 40))
        : [],
      kind: String(req.body?.kind ?? '11').slice(0, 20),
      activeTeam: req.body?.activeTeam === 'away' ? 'away' : 'home',
      board: String(req.body?.board ?? '').slice(0, MAX_BOARD),
    }

    const result = await askAssistant(message, context)
    res.json(result)
  } catch (err) {
    // A provider outage is not the coach's problem to debug, but it also must
    // not read as "I didn't understand you" — the client says so plainly.
    // BadRequest and TooManyRequests both carry a status and are already shaped
    // for the client; anything else reaching here came from the provider.
    if (err?.status) return next(err)
    console.error('Assistant request failed:', err.message)
    res.status(502).json({ error: 'The assistant could not be reached. Try again in a moment.' })
  }
})
