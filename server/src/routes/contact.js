import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { run } from '../db.js'
import { encrypt } from '../crypto.js'
import { consume } from '../rateLimit.js'
import { BadRequest, validateEmail } from '../validate.js'
import { forwardContactMessage } from '../contactForward.js'

/**
 * The contact form, which is the only way to reach anybody about this product.
 *
 * The privacy policy promises access, correction and erasure, and the terms
 * promise a copyright channel. Both said to write to "the address published in
 * the project's repository", and that repository is private — so the route
 * every one of those promises named led nowhere. This is that route.
 *
 * **Unauthenticated on purpose, and that is the security problem to hold in
 * mind rather than the oversight to fix.** A right of erasure that requires an
 * account is not a right of erasure: the person most likely to need it is
 * somebody who deleted theirs, or a guest who never had one. So this is a
 * public write endpoint, which makes it the only one in the product, and the
 * limits below are what stand in for the sign-in that is deliberately absent.
 */
export const contactRouter = Router()

/**
 * What a message may be about.
 *
 * A fixed list rather than a free-text subject, for two reasons. It is what
 * lets the table be triaged without decrypting anything — `topic` is the one
 * column left in the clear — and `copyright` is a named channel the terms have
 * to be able to point at, which a subject line somebody has to guess at is not.
 */
const TOPICS = ['privacy', 'terms', 'copyright', 'security', 'other']

/**
 * Caps, and they are storage limits rather than editorial ones.
 *
 * A public endpoint that writes to a database is a public endpoint that fills a
 * disk, and the rate limit below bounds how *often* rather than how much. 4000
 * characters is several times any real request and still bounds a day's worth
 * of accepted messages to something trivial.
 */
const MAX_BODY = 4000
const MIN_BODY = 10

contactRouter.post('/', async (req, res, next) => {
  try {
    const topic = String(req.body?.topic ?? '').trim()
    if (!TOPICS.includes(topic))
      throw new BadRequest('Choose what your message is about.', 'topic')

    // Through the same validator the sign-up form uses, so one idea of what an
    // address is. It is required because every promise this route serves is a
    // promise to *answer*, and there is nowhere else to send the answer.
    const replyTo = validateEmail(req.body?.replyTo)

    const body = String(req.body?.body ?? '').trim()
    if (body.length < MIN_BODY) throw new BadRequest('Tell us a little more.', 'body')
    if (body.length > MAX_BODY)
      throw new BadRequest('That message is too long. Please shorten it.', 'body')

    /**
     * Two limits, and they are counting different abuses.
     *
     * The address limit stops one person filling the table; the network limit
     * stops one script doing it from a thousand addresses, which the first
     * cannot see. Neither is a security boundary on its own — an address is
     * unverified here and a network is shared — which is why the caps are
     * generous enough that a real person sending a genuine follow-up never
     * meets them, and low enough that a loop does within seconds.
     *
     * **`max` is one more than the number that gets through, and that is the
     * shared limiter's meaning rather than a fudge here.** `BUMP_SQL` locks when
     * `count >= max`, so the `max`th call is the one refused — which reads
     * naturally for the failure counters it was written for ("five wrong answers
     * lock the account") and is off by one for an allowance. Six and twenty-one
     * are therefore five an hour per address and twenty per network, which is
     * what the numbers below are meant to say. Both boundaries are pinned by
     * `contact.test.js`, because this is exactly the kind of thing that drifts.
     */
    await consume(`contact:addr:${replyTo}`, {
      max: 6,
      windowMs: 60 * 60 * 1000,
      message: 'That is a lot of messages. Please wait an hour before sending another.',
    })
    await consume(`contact:ip:${req.ip}`, {
      max: 21,
      windowMs: 60 * 60 * 1000,
      message: 'Too many messages from this connection. Please try again later.',
    })

    const receivedAt = Date.now()
    await run(
      `INSERT INTO contact_messages (id, topic, reply_to, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      randomUUID(),
      topic,
      encrypt(replyTo),
      encrypt(body),
      receivedAt,
    )

    // No id handed back, and nothing to look up with one. A reference number
    // would be a second unauthenticated read of a table full of other people's
    // data protection requests, bought for the convenience of quoting it.
    res.status(202).json({ received: true })

    /**
     * Then put a copy in a mailbox somebody reads — after answering, and
     * without the sender waiting on it.
     *
     * **After the insert, never before, and never in place of it.** The row is
     * the record; this is a notification on top of it. A provider that is down
     * or misconfigured costs a copy, and must never turn somebody's erasure
     * request into a 500 — they would be told to try again later and the
     * request would be *lost* rather than merely undelivered.
     *
     * **After the response, which this did not used to be, and the first real
     * message found out why.** It was awaited before the reply on the argument
     * that a floating promise is a rejection nobody owns. The first message
     * through a freshly restarted process then took longer than the send's own
     * timeout — `contact forward failed: TimeoutError`, once, on the very first
     * attempt after a deploy, with every later one landing in well under a
     * second. Whatever that cold start is paying for, awaiting it meant the
     * sender paid for it too, and the only ways to give the send more room were
     * to make a person watch a form for ten seconds or to accept losing the
     * copy. Answering first removes the trade: the send can have a generous
     * budget because nobody is waiting on it.
     *
     * The rejection argument survives, and is answered rather than dropped.
     * `forwardContactMessage` catches everything and resolves to a boolean —
     * that is what its tests pin — and the `.catch` below is the belt to that
     * braces, because an unhandled rejection in this process is a crash and
     * "cannot throw" is a property somebody could edit away without noticing
     * what depended on it.
     */
    void forwardContactMessage({ topic, replyTo, body, receivedAt }).catch(() => {})
  } catch (err) {
    next(err)
  }
})
