import LegalPage, { Clause } from './LegalPage'
import { ledeFor } from '../../content/marketing.js'

const UPDATED = '3 August 2026'

export default function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" updated={UPDATED} lede={ledeFor('/terms')[0]}>
      <Clause heading="Acceptance of these terms">
        <p>
          By creating an account, by entering a board with a join code, or by otherwise using
          FootyBoard, you agree to be bound by these terms. If you do not accept them, you must not
          use the service. Where you use FootyBoard on behalf of a club or other organisation, you
          confirm that you are authorised to accept these terms on its behalf.
        </p>
        <p>
          The <a href="/privacy" className="text-accent hover:underline">Privacy Policy</a> forms
          part of these terms and describes what is collected and why.
        </p>
      </Clause>

      <Clause heading="Who may use it">
        <p>
          You must be at least 13 years old to use FootyBoard, or at least 16 if you are in the
          United Kingdom or the European Economic Area. By using it you confirm that you meet that
          age. FootyBoard is built for coaches and analysts and is not directed at children.
        </p>
        <p>
          A coach may of course use it to plan sessions for children. Nothing about a player drawn
          on a board is collected about that player: a chip is a number and a position, and the
          board never asks who anybody is.
        </p>
      </Clause>

      <Clause heading="Description of the service">
        <p>
          FootyBoard is a tactics board that runs in a web browser, with an optional account that
          saves your work. It is provided free of charge and without any commitment as to
          availability. It runs on a single machine and is unavailable whenever that machine is,
          which is a normal condition of the service rather than a fault.
        </p>
        <p>
          There is a nightly backup of the database, kept for fourteen days, and it exists to
          recover the whole service from a failure rather than to recover one person's work.{' '}
          <strong className="text-ink">Do not treat it as a safety net for your boards.</strong>{' '}
          Export anything you would be sorry to lose; the export tools produce PNG, GIF and video
          files for exactly that.
        </p>
      </Clause>

      <Clause heading="Your account">
        <p>
          Creating an account allows your boards to be saved and retrieved. You are responsible for
          maintaining the confidentiality of your password, of your security question's answer, and
          of any recovery codes you are given, and for all activity that occurs under your account.
        </p>
        <p>
          <strong className="text-ink">
            A join code gives you an account with no email address and no password.
          </strong>{' '}
          It exists only as long as the browser it was issued to keeps its cookie: there is no
          address to send a reset to and no way for anyone to prove it is yours, so if you lose that
          browser or clear its data, that account and its boards are gone and cannot be restored.
          Use the <em>Claim</em> page to turn it into a full account if you intend to keep anything.
        </p>
        <p>
          If you forget your password, answering your security question lets you set a new one.
          Repeated wrong answers lock the account temporarily. Completing a reset signs out all
          existing sessions for the account, as does changing your password while signed in.
          Deleting your account removes its boards immediately, and no backup is retained from which
          they could be restored.
        </p>
        <p>
          You may turn on two-step sign-in, which adds a code from an authenticator app to your
          password. With it on, that code is also required before your security question can reset
          anything. You are given ten recovery codes when you turn it on, shown once, and each works
          a single time. If you lose both the authenticator app and those codes, access to that
          account cannot be restored by us or by anyone else, and its boards cannot be recovered.
        </p>
      </Clause>

      <Clause heading="Acceptable use">
        <p>You agree not to:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>use FootyBoard for any unlawful purpose, or to infringe the rights of others;</li>
          <li>
            attempt to disrupt, overload, or reverse engineer the service in a manner that harms
            other users or their devices;
          </li>
          <li>
            represent FootyBoard as your own product, or remove attribution from material that
            carries it;
          </li>
          <li>upload or store content that you do not have the right to use;</li>
          <li>
            scrape or automate access beyond ordinary use of a browser, or work around the rate
            limits, join-code expiry, or editing locks;
          </li>
          <li>
            use the service, or anything it produces, as the basis for an automated decision
            affecting a person.
          </li>
        </ul>
        <p>
          We may block a network address or a session, refuse a join code, or remove access from an
          account that breaches this section, without notice where the breach is ongoing. Sections
          that by their nature outlast your use of the service — the disclaimer, the limitation of
          liability, the indemnity and the governing law — survive it.
        </p>
      </Clause>

      <Clause heading="What you get out of it">
        <p>
          Boards you export as PNG, GIF or video are yours. You may use them for any lawful purpose,
          including commercially, without attribution and without asking. The watermark is there so
          people can find the tool, and you are free to crop it.
        </p>
        <p>
          Where the assistant has written or arranged something, that output is yours on the same
          terms, and two caveats come with it. Text produced by a general-purpose model may not
          attract copyright protection in every jurisdiction. And you are responsible for what you
          publish: check it before it goes anywhere, particularly if a board carries a club's marks,
          a real person's name, or anything you did not draw yourself.
        </p>
      </Clause>

      <Clause heading="Our own rights">
        <p>
          The FootyBoard name, the design of the site, its source code and its interface belong to
          the operator. Nothing in these terms gives you a licence to copy, redistribute or present
          them as your own. Your boards and your exports are explicitly not covered by this — they
          are dealt with in the two sections above and they are yours.
        </p>
      </Clause>

      <Clause heading="Your content">
        <p>
          Your boards, drawings, and notes remain yours. They are stored solely so that you can
          retrieve them, and no licence to use them for any other purpose is claimed. You remain
          responsible for keeping your own copies. The export tools produce PNG, GIF, and video
          files for that purpose.
        </p>
      </Clause>

      <Clause heading="Shared boards">
        <p>
          A board may be shared by link or by join code. Anyone who holds a valid link or code and
          signs in may open that board and, unless editing has been locked by its owner, modify it.
          You are responsible for whom you give a link or code to. A join code stops working after
          a few hours and the owner can issue a new one. The owner of a board may revoke sharing,
          remove a member, or lock editing at any time.
        </p>
        <p>
          While you are in a shared board, everyone else in it sees one label for you: a generated
          name if the board's owner has turned on anonymous guests, otherwise the display name you
          chose, otherwise the email address on your account. Setting a display name is what keeps
          an address out of a room, and the{' '}
          <a href="/privacy" className="text-accent hover:underline">Privacy Policy</a> sets out the
          order in full.
        </p>
      </Clause>

      <Clause heading="The assistant">
        <p>
          The assistant interprets what you type on your own device. If you switch on the optional
          online fallback, a message it does not recognise is sent, with a description of what is on
          the board, to a third-party model provider. The Privacy Policy sets out exactly what
          travels and when.
        </p>
        <p>
          What comes back is a suggestion about a drawing. It is not coaching, medical, or
          professional advice, it can be wrong, and what you do with it is your decision.
        </p>
        <p>
          <strong className="text-ink">The model is Google's Gemini, and Google's terms apply to
          what you send it.</strong>{' '}
          Which of their terms depends on the API key this installation was set up with, and on
          their free tier that can include human review of what is sent.{' '}
          <a
            href="https://ai.google.dev/gemini-api/terms"
            className="text-accent hover:underline"
            rel="noreferrer"
            target="_blank"
          >
            Their API terms
          </a>{' '}
          and{' '}
          <a
            href="https://policies.google.com/privacy"
            className="text-accent hover:underline"
            rel="noreferrer"
            target="_blank"
          >
            privacy policy
          </a>{' '}
          govern that half, and it is why the fallback is a choice and not a default. We do not
          train any model on anything you type or draw.
        </p>
      </Clause>

      <Clause heading="Availability and changes">
        <p>
          Features may be changed or withdrawn as the project develops. A change to the way boards
          are stored may render a previously saved board unreadable, in which case the application
          will notify you and start a new board rather than fail without explanation.
        </p>
      </Clause>

      <Clause heading="Disclaimer">
        <p>
          FootyBoard is provided "as is" and "as available", without warranties of any kind, whether
          express or implied, including warranties of fitness for a particular purpose and
          non-infringement, to the fullest extent permitted by law.
        </p>
      </Clause>

      <Clause heading="Limitation of liability">
        <p>
          To the fullest extent permitted by law, we accept no liability for lost boards, lost work,
          lost opportunity, or any indirect or consequential loss arising from your use of
          FootyBoard.
        </p>
        <p>
          Where liability cannot be excluded, our total liability to you for any claim is limited to
          GBP 100. That figure is not a valuation of your work; it reflects that this is given away
          free, and it is stated plainly rather than left to be argued about.
        </p>
        <p>
          Nothing in these terms limits any liability that cannot be limited by law. This includes,
          for users in the United Kingdom, liability for death or personal injury caused by
          negligence and liability for fraud. Consumers in the United Kingdom and the European
          Union retain their statutory rights, and nothing in these terms overrides them. Some
          jurisdictions do not allow the exclusion or limitation of certain warranties or
          liabilities; where that is so, our liability is limited to the maximum extent that
          jurisdiction permits, and the limits above may not apply to you.
        </p>
      </Clause>

      <Clause heading="Indemnity">
        <p>
          You agree to cover us against any claim, loss or reasonable cost arising from content you
          put on a board, from what you do with something you exported, from your breach of these
          terms, or from your breach of somebody else's rights or of the law.
        </p>
      </Clause>

      <Clause heading="Termination">
        <p>
          You may stop using the service at any time. Deleting your account removes it, and every
          board saved under it, from the live database immediately; a backup taken beforehand may
          hold a copy for up to fourteen days, after which it goes with that backup. Clearing your
          browser's site data signs you out and clears what is held on the device, but leaves a
          saved account as it was — and deletes a join-code account outright, since the browser is
          all it consists of.
        </p>
      </Clause>

      <Clause heading="Changes to these terms">
        <p>
          These terms may be updated. When they are, the date at the top of this page changes.{' '}
          <strong className="text-ink">
            Continuing to use FootyBoard after that date means you accept the revised terms.
          </strong>{' '}
          If a change matters enough to need saying out loud rather than dating, it will be said in
          the application as well.
        </p>
      </Clause>

      <Clause heading="Governing law">
        <p>
          These terms are governed by the laws of England and Wales. If you are a consumer resident
          elsewhere, including in the United States, you retain the benefit of any mandatory
          consumer protections of your home jurisdiction and may bring proceedings there where
          local law gives you that right.
        </p>
      </Clause>

      <Clause heading="Contact, and copyright complaints">
        <p>
          Questions about these terms go through the{' '}
          <a href="/contact" className="text-accent hover:underline">
            contact form
          </a>
          . Until August 2026 this page pointed at an address in the project's repository, and that
          repository is private — so the route it named reached nobody.
        </p>
        <p>
          <strong className="text-ink">
            If you believe something here infringes your copyright or trade mark,
          </strong>{' '}
          use the same form and choose the copyright topic. Say what the work is, where on
          FootyBoard it appears, and how to reach you, and confirm that you are the rights holder or
          are authorised to act for them. Material that is plainly infringing is removed, and an
          account that repeats it loses access.
        </p>
      </Clause>
    </LegalPage>
  )
}
