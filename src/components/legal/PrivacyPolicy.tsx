import LegalPage, { Clause } from './LegalPage'

const UPDATED = '25 July 2026'

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated={UPDATED}>
      <Clause heading="The short version">
        <p>
          If you use Soccerboard without an account, everything stays in your browser. If you create
          one, two things reach our server and nothing else: your email address, and the boards you
          save. Your password is never stored in readable form.
        </p>
        <p>
          The tactics assistant still runs entirely on your device. What you type into it is never
          sent anywhere. We do not sell or share anything, and we run no advertising or analytics.
        </p>
      </Clause>

      <Clause heading="Who this applies to">
        <p>
          This policy covers everyone who uses Soccerboard, and is written to meet the expectations
          of the UK GDPR and Data Protection Act 2018, the EU GDPR, and US state privacy laws
          including the California Consumer Privacy Act as amended by the CPRA.
        </p>
      </Clause>

      <Clause heading="What is stored, and where">
        <p>On our server, tied to your account:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong className="text-ink">Your email address</strong>, used to identify the account
            and nothing else. We send no marketing.
          </li>
          <li>
            <strong className="text-ink">A scrypt hash of your password</strong> with a random
            per-account salt. The password itself is never written down and cannot be recovered
            from the hash.
          </li>
          <li>
            <strong className="text-ink">Your boards</strong> — player positions, drawings,
            animation frames, and view settings.
          </li>
          <li>
            <strong className="text-ink">Session records</strong>, so you stay signed in, and a
            count of failed sign-ins so an account can be locked after repeated wrong guesses.
          </li>
        </ul>
        <p>In your browser:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong className="text-ink">A session cookie</strong>, which your browser sends back to
            keep you signed in. It cannot be read by scripts on the page.
          </li>
          <li>
            <strong className="text-ink">Small preferences</strong>, such as whether you have
            dismissed the assistant notice.
          </li>
        </ul>
      </Clause>

      <Clause heading="What we do not do">
        <p>
          We do not run analytics, advertising, tracking pixels, session recording, or third-party
          scripts that profile you. We do not set cookies. We do not build a profile of you, and
          nothing you do here feeds automated decision-making or targeted advertising.
        </p>
        <p>
          Fonts are bundled with the application rather than fetched from a font CDN, so loading a
          page does not disclose your IP address to a third party.
        </p>
      </Clause>

      <Clause heading="The assistant">
        <p>
          The tactics assistant is deterministic and offline. It interprets what you type using
          rules that ship with the application. Your messages are not sent to us or to any AI
          provider. If a future version adds a hosted assistant, it will be clearly labelled and
          off until you switch it on.
        </p>
      </Clause>

      <Clause heading="Legal basis for processing (UK and EU)">
        <p>
          Where the UK or EU GDPR applies, our basis is your consent, given when you tick the box
          to create an account, and our legitimate interest in providing a working tactics board.
          You can withdraw consent at any time by deleting your account or clearing site data.
        </p>
      </Clause>

      <Clause heading="Your rights">
        <p>
          UK and EU users have the right to access, correct, erase, restrict, port, and object to
          the processing of their personal data. California residents have the right to know,
          delete, correct, and opt out of the sale or sharing of personal information — Soccerboard
          does not sell or share personal information, and never has.
        </p>
        <p>
          You can exercise most of these yourself, immediately: use{' '}
          <strong className="text-ink">Delete account</strong> in the board's account menu. That
          removes your account, every board saved under it, and all session records, straight away
          and without a backup. For anything else, write to the address in the project's repository.
        </p>
      </Clause>

      <Clause heading="Retention">
        <p>
          Your account and boards are kept until you delete them. Expired sessions are cleared
          automatically. Deletion is immediate and there is no backup to restore from, so treat it
          as final.
        </p>
      </Clause>

      <Clause heading="International transfers">
        <p>
          Your account and boards are held wherever this instance of Soccerboard is hosted. If that
          is outside your country, the transfer is covered by the standard safeguards for the
          hosting arrangement in use.
        </p>
      </Clause>

      <Clause heading="Children">
        <p>
          Soccerboard is intended for coaches and analysts and is not directed at children under
          13. We knowingly collect nothing from anyone, children included.
        </p>
      </Clause>

      <Clause heading="Security, honestly stated">
        <p>
          Passwords are hashed with scrypt and a per-account salt, compared in constant time, and
          never stored in readable form. Sessions are random tokens held in a cookie your browser's
          scripts cannot read, and only a hash of each token is kept, so a copy of the database
          would not yield working sessions. Repeated failed sign-ins lock an account temporarily.
        </p>
        <p>
          What we do not yet have: encryption of board contents at rest, two-factor authentication,
          or a password reset. Treat a Soccerboard account as protecting tactical work, not
          sensitive personal information.
        </p>
      </Clause>

      <Clause heading="Changes and contact">
        <p>
          If this policy changes materially, the date above changes and the new version applies from
          then. Questions can be sent to the address published in the project's repository.
        </p>
      </Clause>
    </LegalPage>
  )
}
