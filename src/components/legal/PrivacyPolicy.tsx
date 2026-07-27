import LegalPage, { Clause } from './LegalPage'

const UPDATED = '27 July 2026'

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated={UPDATED}>
      <Clause heading="The short version">
        <p>
          If you use FootyBoard without an account, everything stays in your browser. If you create
          one, two things reach our server and nothing else: your email address, and the boards you
          save. Your password is never stored in readable form, and the contents of your boards are
          encrypted before they are written down.
        </p>
        <p>
          The tactics assistant runs on your device. The one exception is the optional online
          fallback: if you switch it on, a message the on-device assistant does not understand is
          sent to Google, along with a description of what is on your board. It is off until you
          turn it on, and the section below says exactly what travels.
        </p>
        <p>We do not sell or share anything, and we run no advertising or analytics.</p>
      </Clause>

      <Clause heading="Who this applies to">
        <p>
          This policy covers everyone who uses FootyBoard, and is written to meet the expectations
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
            <strong className="text-ink">Your boards</strong>: player positions, drawings,
            animation frames, and view settings. These are encrypted before they are stored. The
            board's <em>name</em> is not, which is a deliberate trade covered below.
          </li>
          <li>
            <strong className="text-ink">Session records</strong>, so you stay signed in, and a
            count of failed sign-ins so an account can be locked after repeated wrong guesses.
          </li>
          <li>
            <strong className="text-ink">A counter against your network address</strong>, so that
            someone trying passwords or guessing join codes can be slowed down. It is a count and a
            clock, nothing more, and it resets when the window passes or you sign in.
          </li>
          <li>
            <strong className="text-ink">Whether you turned the online assistant on</strong>, and
            when, if you did.
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
            dismissed the assistant notice, and whether you have allowed it online.
          </li>
        </ul>
      </Clause>

      <Clause heading="What we do not do">
        <p>
          We do not run analytics, advertising, tracking pixels, session recording, or third-party
          scripts that profile you. The only cookie we set is the one that keeps you signed in. We
          do not build a profile of you, and nothing you do here feeds automated decision-making or
          targeted advertising.
        </p>
        <p>
          Fonts are bundled with the application rather than fetched from a font CDN, so loading a
          page does not disclose your IP address to a third party.
        </p>
      </Clause>

      <Clause heading="The assistant">
        <p>
          The assistant is rule-based and offline first. Every phrasing it knows is interpreted on
          your device, by rules that ship with the application. Nothing leaves your browser for
          those, and that is most of what people type.
        </p>
        <p>
          When it does not recognise a message, and only then, it can hand that message to Google's
          Gemini API through our server. Two things have to be true first: the installation has to
          be configured with a Google API key, and you have to have switched the fallback on in the
          assistant panel. Until you do, the assistant stays entirely on your device.
        </p>
        <p>If you do switch it on, what is sent to Google for that one message is:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>the message you typed;</li>
          <li>
            <strong className="text-ink">a description of what is on your board</strong>: the shape
            each team is in, how high its back line is sitting, the format of the pitch, and how
            many training props are on it;
          </li>
          <li>the list of formation names this pitch offers, and which team is currently selected.</li>
        </ul>
        <p>
          Your email address, your account, the board's name, and the board's saved file are not
          part of that request. The reply comes back through our server and is not stored by us.
          What Google does with the request is governed by their own terms for that API, and is
          outside our control, which is the honest reason this is a choice and not a default.
        </p>
        <p>
          You can withdraw permission at any time in the same panel. The assistant then goes back to
          being offline, instant, and free.
        </p>
      </Clause>

      <Clause heading="Sharing a board">
        <p>
          A board can be shared by link or by a six-letter join code. Both give whoever holds them
          access to that board, so treat them as you would a key.
        </p>
        <p>
          <strong className="text-ink">
            While you are in a shared board, your email address is visible to everyone else in it.
          </strong>{' '}
          It is how the presence list says who is on the board and whose cursor is whose. A join
          code is designed to be read out to a room, so consider who is in that room: anyone who
          uses the code and signs in will see the address on your account. The owner of a board can
          remove a member or revoke the link at any time.
        </p>
      </Clause>

      <Clause heading="Legal basis for processing (UK and EU)">
        <p>
          Where the UK or EU GDPR applies, our basis is your consent, given when you tick the box
          to create an account, and our legitimate interest in providing a working tactics board.
          The online assistant rests on its own separate consent, given in the assistant panel and
          withdrawable there. You can withdraw the rest at any time by deleting your account or
          clearing site data.
        </p>
      </Clause>

      <Clause heading="Your rights">
        <p>
          UK and EU users have the right to access, correct, erase, restrict, port, and object to
          the processing of their personal data. California residents have the right to know,
          delete, correct, and opt out of the sale or sharing of personal information. FootyBoard
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
          automatically, as are password reset links nobody followed. Deletion is immediate and
          there is no backup to restore from, so treat it as final.
        </p>
      </Clause>

      <Clause heading="International transfers">
        <p>
          Your account and boards are held wherever this instance of FootyBoard is hosted. If that
          is outside your country, the transfer is covered by the standard safeguards for the
          hosting arrangement in use.
        </p>
        <p>
          Two other parties can receive data, and only in the narrow cases described above: Google,
          if you turned the online assistant on, and whichever service this instance is configured
          to send email through, which receives your address in order to deliver a password reset
          link. Both may process it outside your country.
        </p>
      </Clause>

      <Clause heading="Children">
        <p>
          FootyBoard is intended for coaches and analysts and is not directed at children under
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
          Board contents are encrypted with AES-256-GCM before they reach the database, so a stolen
          copy of it is noise without the key, which is held in the server's environment and never
          in the database itself. Board <em>names</em> are the deliberate exception: they are stored
          in the clear so that your board list can be sorted and paged without decrypting every row
          you own. Put nothing in a board's title that you would not want read.
        </p>
        <p>
          If you forget your password you can reset it by email. The link is stored only as a hash,
          expires in 30 minutes, and works exactly once. Completing a reset signs out every session
          on the account, so a session somebody else took cannot outlive the password changed to
          stop it.
        </p>
        <p>
          What we do not have: two-factor authentication, and any way to sign out other devices
          short of resetting your password. Sessions last 30 days. Beyond HTTPS in transit and the
          encryption described above, treat a FootyBoard account as protecting tactical work rather
          than sensitive personal information.
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
