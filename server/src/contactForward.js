/**
 * Put a contact message in a mailbox somebody actually reads.
 *
 * **The table was the whole delivery mechanism, and that is why this exists.**
 * `contact_messages` is triageable by design — `topic` and the timestamps are in
 * the clear precisely so a row can be found without a key — but somebody has to
 * think to go and look, with `psql`, on the machine that serves the site. The
 * first real message sat unhandled for days for exactly that reason, and it was
 * a data protection request, which is the category with a clock on it.
 *
 * **This is a notification, never a dependency, and the order in the route is
 * what makes that true.** The row is written first and this runs after it, with
 * every failure swallowed and logged. A mail provider being down, rate-limiting,
 * or misconfigured must never turn a person's erasure request into a 500 — they
 * would simply be told to try again later, and the request would be lost rather
 * than merely undelivered. That distinction is the reason `handoff.md` says
 * there is no mailer anywhere: a mail dependency in the *password recovery* path
 * is a liability, because there the mail **is** the mechanism. Here the database
 * is the mechanism and the mail is a convenience on top of it.
 *
 * **It sends over HTTPS rather than SMTP, which is what keeps it dependency
 * free.** Node has no SMTP client, so SMTP means a package; a transactional API
 * is one `fetch`, which is the same bargain `assistant.js` already takes for
 * Gemini. Written against Resend because its API is a single POST and its
 * `onboarding@resend.dev` sender delivers to the account owner's own address
 * with no domain verification at all — which is exactly this case, one operator
 * forwarding to their own mailbox. Point `CONTACT_FORWARD_FROM` at a verified
 * address on `footyboard.me` when there is one.
 */

const ENDPOINT = 'https://api.resend.com/emails'

/** Where a message goes. The operator's mailbox, not a user's. */
const to = () => process.env.CONTACT_FORWARD_TO?.trim()

/**
 * Whether forwarding is configured at all.
 *
 * Both halves are required and neither has a default that would guess: without
 * a key there is nothing to send with, and without an address there is nowhere
 * to send. Unset, the route behaves exactly as it did before this file existed,
 * which is the property that makes this safe to deploy ahead of the account
 * being set up.
 */
export const forwardingEnabled = () => Boolean(process.env.RESEND_API_KEY?.trim() && to())

/** What the operator sees in their inbox before opening anything. */
const subjectFor = (topic) => `FootyBoard contact: ${topic}`

/**
 * The message as an email.
 *
 * Plain text, and the body is not escaped or marked up, because it is a person's
 * prose going to one mailbox rather than HTML going to a browser. `replyTo` is
 * the sender's address, so answering is a reply rather than a copy-paste — which
 * is the whole point of the feature, and the one thing the database row could
 * never do without somebody decrypting it by hand.
 */
export function emailFor({ topic, replyTo, body, receivedAt }) {
  return {
    from: process.env.CONTACT_FORWARD_FROM?.trim() || 'onboarding@resend.dev',
    to: [to()],
    reply_to: replyTo,
    subject: subjectFor(topic),
    text: [
      `Topic:    ${topic}`,
      `Reply to: ${replyTo}`,
      `Received: ${new Date(receivedAt).toISOString()}`,
      '',
      body,
      '',
      '--',
      'Sent by the FootyBoard contact form. The message is also stored, encrypted,',
      'in contact_messages; this email is a copy so it does not have to be dug out.',
    ].join('\n'),
  }
}

/**
 * Send it, and never throw.
 *
 * Returns whether it went, so a caller that wants to know can ask, and so the
 * tests can assert on it. The route ignores the answer on purpose: there is
 * nothing useful to tell the person who wrote in, whose message is safely stored
 * either way, and an error mentioning a mail provider would be describing this
 * service's plumbing to a stranger.
 *
 * **Timed out rather than left to hang, and the budget is thirty seconds
 * because nobody is waiting on it.** It used to be ten, chosen when this was
 * awaited before the response, where the number was a compromise between giving
 * the provider room and making a person watch a form. The first message through
 * a freshly restarted process spent all ten of them — `contact forward failed:
 * TimeoutError`, once, on the first attempt after a deploy, with every later
 * one completing in well under a second. Whatever a cold process is paying for
 * on its first outbound TLS connection, ten seconds did not cover it and the
 * copy was lost. The route answers first now, so the only thing this bound has
 * to do is stop a silent socket holding a handle forever.
 */
export async function forwardContactMessage(message) {
  if (!forwardingEnabled()) return false

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailFor(message)),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      // The status and nothing else. A provider's error body can quote the
      // message it refused, and this line goes to a log that is not encrypted.
      console.error(`contact forward failed: ${response.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`contact forward failed: ${err.name}`)
    return false
  }
}
