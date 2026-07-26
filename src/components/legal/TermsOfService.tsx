import LegalPage, { Clause } from './LegalPage'

const UPDATED = '25 July 2026'

export default function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" updated={UPDATED}>
      <Clause heading="Agreeing to these terms">
        <p>
          By creating an account or using Soccerboard, you agree to these terms. If you do not agree
          with them, do not use the service. Where you use Soccerboard on behalf of a club or
          organisation, you confirm you are authorised to accept these terms for it.
        </p>
      </Clause>

      <Clause heading="What Soccerboard is">
        <p>
          Soccerboard is a tactics board that runs in your web browser, with an optional account
          that saves your work. It is provided free of charge, with no uptime commitment and no
          backups — if a board matters to you, export it.
        </p>
      </Clause>

      <Clause heading="Your account">
        <p>
          Creating an account lets your boards be saved and picked up again. You are responsible for
          keeping your password to yourself and for what happens under your account.
        </p>
        <p>
          There is no password reset yet, so a forgotten password means losing access to that
          account. Deleting your account removes its boards immediately, and we keep no backup to
          restore them from.
        </p>
      </Clause>

      <Clause heading="Acceptable use">
        <p>You agree not to:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>use Soccerboard for anything unlawful, or to infringe anyone's rights;</li>
          <li>
            attempt to break, overload, or reverse the service in order to harm other users or their
            devices;
          </li>
          <li>
            present Soccerboard as your own product, or remove attribution from material that
            carries it;
          </li>
          <li>upload or store content you have no right to use.</li>
        </ul>
      </Clause>

      <Clause heading="Your content">
        <p>
          Your boards, drawings, and notes are yours. We store them so you can get them back, and
          claim no licence to use them for anything else. You are responsible for keeping your own
          copies — the export tools produce PNG, GIF, and video files for
          exactly that purpose.
        </p>
      </Clause>

      <Clause heading="Availability and changes">
        <p>
          Features may change or be removed as the project develops. A change to how boards are
          stored may make a previously saved board unreadable, in which case the application will
          tell you and start a fresh board rather than fail silently.
        </p>
      </Clause>

      <Clause heading="Disclaimer">
        <p>
          Soccerboard is provided "as is" and "as available", without warranties of any kind,
          express or implied, including fitness for a particular purpose and non-infringement, to
          the fullest extent permitted by law.
        </p>
      </Clause>

      <Clause heading="Limitation of liability">
        <p>
          To the fullest extent permitted by law, we are not liable for lost boards, lost work, lost
          opportunity, or any indirect or consequential loss arising from your use of Soccerboard.
        </p>
        <p>
          Nothing in these terms limits liability that cannot be limited by law — including, for UK
          users, liability for death or personal injury caused by negligence or for fraud. Consumers
          in the UK and EU keep their statutory rights, and nothing here overrides them.
        </p>
      </Clause>

      <Clause heading="Ending your use">
        <p>
          You can stop at any time by deleting your account or clearing site data, which removes
          your account and boards from the device immediately.
        </p>
      </Clause>

      <Clause heading="Governing law">
        <p>
          These terms are governed by the laws of England and Wales. If you are a consumer resident
          elsewhere — including in the United States — you keep the benefit of any mandatory
          consumer protections of your home jurisdiction, and may bring proceedings there where
          local law gives you that right.
        </p>
      </Clause>

      <Clause heading="Contact">
        <p>Questions about these terms can be sent to the address published in the project's repository.</p>
      </Clause>
    </LegalPage>
  )
}
