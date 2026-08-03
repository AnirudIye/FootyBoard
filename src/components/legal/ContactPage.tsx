import { useState } from 'react'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import LegalPage, { Clause } from './LegalPage'

/**
 * The only way to reach anybody about this product.
 *
 * It exists because the policy pages promised a route that did not exist. Both
 * of them said to write to "the address published in the project's repository",
 * and that repository is private — so a promise of access, correction and
 * erasure, and a promise of a copyright channel, named a door with nothing
 * behind it. A form rather than an address because there is no mail anywhere in
 * this product to send one to, and because an address on a public page is
 * scraped within days.
 *
 * On the legal shell rather than the auth one: it is the page the policies link
 * to, it wants their measure and their footer, and nothing here is a credential.
 */

/**
 * What a message can be about, and why the list is fixed.
 *
 * It is what lets the stored table be triaged without decrypting anything —
 * `topic` is the one column left in the clear — and `copyright` has to be a
 * named channel the Terms can point at rather than a subject line somebody has
 * to guess.
 */
const TOPICS = [
  ['privacy', 'Privacy — my data, access, correction or erasure'],
  ['terms', 'Terms of Service'],
  ['copyright', 'Copyright or intellectual property complaint'],
  ['security', 'A security problem'],
  ['other', 'Something else'],
] as const

const field =
  'w-full rounded border border-rule bg-surface px-3 py-2 text-[14px] text-ink ' +
  'placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:outline-offset-1 focus-visible:outline-accent'

const label = 'mb-1.5 block font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3'

export default function ContactPage() {
  const [topic, setTopic] = useState<string>('privacy')
  const [replyTo, setReplyTo] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.contact(topic, replyTo.trim(), body.trim())
      setSent(true)
    } catch (err) {
      setError(toUserMessage(err, 'That did not send. Please try again in a moment.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <LegalPage title="Contact" updated="3 August 2026">
      <Clause heading="What this is for">
        <p>
          This form reaches whoever runs this installation of FootyBoard. It is the route the
          Privacy Policy and the Terms of Service both point at: data protection requests,
          copyright complaints, security reports, and anything else about how the service works.
        </p>
        <p>
          You do not need an account to use it, and that is deliberate — the person most likely to
          be asking for their data to be erased is somebody who has already deleted theirs.
        </p>
      </Clause>

      {sent ? (
        <Clause heading="Sent">
          <p>
            Your message has been received. A reply will go to the address you gave. There is one
            person behind this, so please allow up to 30 days, which is the limit the Privacy
            Policy commits to for a data protection request.
          </p>
        </Clause>
      ) : (
        <Clause heading="Send a message">
          <form onSubmit={onSubmit} className="space-y-4 pt-1">
            <div>
              <label htmlFor="contact-topic" className={label}>
                What is it about
              </label>
              <select
                id="contact-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className={field}
              >
                {TOPICS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="contact-reply" className={label}>
                Where to reply
              </label>
              <input
                id="contact-reply"
                type="email"
                required
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className={field}
              />
              {/* Said here rather than only in the policy, because this is the
                  moment somebody is deciding whether to type it. */}
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
                Used to answer you and for nothing else. It is stored encrypted, alongside your
                message, and deleted once the exchange is finished.
              </p>
            </div>

            <div>
              <label htmlFor="contact-body" className={label}>
                Your message
              </label>
              <textarea
                id="contact-body"
                required
                rows={7}
                maxLength={4000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Tell us what you need."
                className={`${field} resize-y`}
              />
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
                Please do not include passwords, recovery codes, or your two-step secret. Nobody
                here will ever ask for them.
              </p>
            </div>

            {error && (
              <p role="alert" className="text-[14px] leading-relaxed text-alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center rounded bg-accent px-4 py-2
                text-[14px] font-medium text-paper transition-colors duration-150
                hover:bg-accent-hover disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send message'}
            </button>
          </form>
        </Clause>
      )}

      <Clause heading="What happens to it">
        <p>
          Your message and the address you gave are encrypted before they are stored, with the same
          key and the same cipher the boards use, and are held only until the exchange is finished.
          Nothing you send here is used for anything except answering you.
        </p>
        <p>
          If you are reporting a security problem, please say so in the topic and give enough
          detail to reproduce it. Please do not post it publicly before it is fixed.
        </p>
      </Clause>
    </LegalPage>
  )
}
