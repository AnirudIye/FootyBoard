import LegalPage, { Clause } from './LegalPage'

const UPDATED = '3 August 2026'

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated={UPDATED}>
      <Clause heading="The short version">
        <p>
          If you use FootyBoard without signing in, everything stays in your browser. If you sign
          up, two things reach our server and nothing else: your email address, and the boards you
          save. Your password is never stored in readable form, and the contents of your boards are
          encrypted before they are written down.
        </p>
        <p>
          <strong className="text-ink">
            If you were let in by a join code rather than by signing up, you have an account with no
            email address on it at all.
          </strong>{' '}
          It is a real account — your boards save, and you can be named in a room — but there is no
          address attached to it, and nothing here can send you one. The section below on guest
          accounts says what that means in both directions.
        </p>
        <p>
          The tactics assistant runs on your device. The one exception is the optional online
          fallback: if you switch it on, a message the on-device assistant does not understand is
          sent to Google, along with a description of what is on your board. It is off until you
          turn it on, and the section below says exactly what travels.
        </p>
        <p>
          Most of that assistant is not artificial intelligence at all. It is a set of rules that
          ship with the page. Only the optional online fallback uses a general purpose AI model, its
          tactical answers can be wrong, and none of it is professional coaching advice. The section
          below called &ldquo;What the AI can and cannot do&rdquo; says so in full.
        </p>
        <p>We do not sell or share anything, and we run no advertising or analytics.</p>
      </Clause>

      <Clause heading="Who this applies to, and who we are">
        <p>
          This policy covers everyone who uses FootyBoard, and is written to meet the expectations
          of the UK GDPR and Data Protection Act 2018, the EU GDPR, and US state privacy laws
          including the California Consumer Privacy Act as amended by the CPRA.
        </p>
        <p>
          The data controller is the individual who operates this installation of FootyBoard. There
          is no company behind it and no data protection officer, because neither the size of the
          operation nor the kind of data it holds requires one. Reach the controller through the{' '}
          <a href="/contact" className="text-accent hover:underline">
            contact form
          </a>
          , which is the route for every request in this policy.
        </p>
      </Clause>

      <Clause heading="Guest accounts">
        <p>
          A join code admits you without a sign-up form. What that creates is a real account with{' '}
          <strong className="text-ink">no email address and no password</strong>: it exists only as
          a row identified by the cookie in your browser, it can own and save boards, and it can be
          named in a room like anybody else.
        </p>
        <p>
          Two consequences worth knowing, and they cut in opposite directions. In your favour: we
          hold no address for you, so there is less about you here than about anybody who signed
          up, and a room cannot name you by an address you never gave. Against you: there is no
          address to send a password reset to and no way for us to prove an account is yours, so{' '}
          <strong className="text-ink">
            if you lose that browser or clear its data, the account and its boards are gone
          </strong>
          . Turning it into a full account on the <em>Claim</em> page is what fixes that, and it is
          also what gives you an address we can answer.
        </p>
        <p>
          Accepting these terms is recorded for a guest exactly as it is for anybody else, timed to
          when you came through the join code.
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
            <strong className="text-ink">Your security question and a hash of its answer</strong>.
            Which question you chose is stored plainly, because it is not a secret. The answer is
            hashed exactly the way your password is, with its own random per-account salt, and
            cannot be recovered from the hash. It is used for one thing: proving it is you when you
            have forgotten your password.
          </li>
          <li>
            <strong className="text-ink">An encrypted copy of your two-step sign-in secret</strong>,
            if you have turned two-step sign-in on. This one is different from your password and
            the difference matters: the server has to work out the same code your authenticator app
            is showing, so it has to be able to read the secret back. It is encrypted with
            AES-256-GCM under the same key your board contents use, which is held in the server's
            environment and never in the database. It is deleted when you turn two-step sign-in
            off.
          </li>
          <li>
            <strong className="text-ink">Hashes of your ten recovery codes</strong>, and which of
            them have been spent. The codes themselves are shown to you once, at the moment you turn
            two-step sign-in on, and are never stored in readable form or shown again.
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
            someone trying passwords, sign-in codes or join codes can be slowed down. It is a count
            and a clock, nothing more, and it resets when the window passes or you sign in.
          </li>
          <li>
            <strong className="text-ink">The display name you chose</strong>, if you set one. It is
            stored in the clear, because its whole purpose is to be shown to other people in a
            room — see &ldquo;Sharing a board&rdquo; for what a room is shown and in what order.
          </li>
          <li>
            <strong className="text-ink">Whether you turned the online assistant on</strong>, and
            when, if you did.
          </li>
        </ul>
        <p>Separately from any account, if you use the contact form:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong className="text-ink">Your message and the address you gave for a reply</strong>,
            both encrypted the way board contents are, plus which of the five topics you picked and
            when it arrived. The topic and the timestamps are in the clear so that unanswered
            messages can be found without decrypting anybody's. It is not joined to an account even
            if you have one, because a request to be erased has to work for somebody who has already
            deleted theirs.
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
          <strong className="text-ink">
            That last point deserves more than a gesture at somebody else's terms.
          </strong>{' '}
          Which terms apply depends on the API key the installation was set up with. On Google's
          free API tier, Google may use what is sent, and the reply it returns, to improve their
          products, and that can include review by people. On their paid tier they state that they
          do not. We cannot tell you from here which one you are using, so if a board description is
          sensitive to you, treat the online assistant as public and leave it off. We do not train
          any model of our own on anything you type or draw.
        </p>
        <p>
          You can withdraw permission at any time in the same panel. The assistant then goes back to
          being offline, instant, and free.
        </p>
      </Clause>

      <Clause heading="What the AI can and cannot do">
        <p>
          This section exists because claims about AI are easy to make and hard to walk back. It is
          written to be accurate rather than impressive, and it errs toward saying less.
        </p>
        <p>
          <strong className="text-ink">Most of the assistant is not AI.</strong> Every phrasing it
          already knows is handled by ordinary rules that ship with the page: pattern matching, no
          model, no network, no learning of any kind. That covers the majority of what people type
          at it. We call it an assistant rather than an AI for exactly that reason, and the panel
          labels itself OFFLINE or HYBRID so you can see which half answered you.
        </p>
        <p>
          <strong className="text-ink">The AI half is a general purpose model, not a football
          one.</strong>{' '}
          It is Google's Gemini. We did not build it, train it, or fine tune it on football, and we
          have not measured it against anything. We make no claim that it is accurate, that it is
          better than any other tool, or that it performs at the level of a qualified coach.
        </p>
        <p>
          <strong className="text-ink">Its tactical advice can be wrong.</strong> Answers about how
          to play with or against a shape are generated text. They may be confidently stated and
          still be mistaken, out of date, or unsuitable for your players. Nothing it says is
          professional coaching, medical, safeguarding, or officiating advice, and it should not be
          the only basis for a decision that affects real people, least of all children.
        </p>
        <p>
          <strong className="text-ink">It cannot act on your board on its own.</strong> The model
          never touches the board directly. It may ask for one of a fixed, published list of actions,
          our server checks that request against that same list before anything runs, and anything
          outside it is discarded. Every change it does make goes onto the same undo stack as your
          own edits, so you can take it back the way you take back anything else.
        </p>
        <p>
          <strong className="text-ink">It makes no decisions about you.</strong> It does not profile
          you, score you, rank you, or make any automated decision producing legal or similarly
          significant effects. It reads a message and a description of a pitch, and it answers.
        </p>
      </Clause>

      <Clause heading="Sharing a board">
        <p>
          A board can be shared by link or by a six-letter join code. Both give whoever holds them
          access to that board, so treat them as you would a key.
        </p>
        <p>
          <strong className="text-ink">What a room calls you, in order.</strong> The relay picks one
          label and sends only that — the others never go on the wire:
        </p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            if the board's owner has turned on <strong className="text-ink">anonymous guests</strong>{' '}
            for that board, a generated name, and nothing else about you leaves regardless of what
            you or anyone else has chosen;
          </li>
          <li>
            otherwise the <strong className="text-ink">display name you chose</strong>, if you have
            set one;
          </li>
          <li>
            otherwise your <strong className="text-ink">email address</strong>;
          </li>
          <li>otherwise — a guest, who has no address — a generated name.</li>
        </ul>
        <p>
          <strong className="text-ink">
            So an address reaches the room only when it is the label you are left with.
          </strong>{' '}
          Setting a display name is what stops that, it takes one field on the <em>Name</em> page,
          and signing up asks for one so that a new account never shows an address to anybody. This
          paragraph said flatly that your address was visible to everyone in a shared board, which
          was true when it was written and is now true only in that third case.
        </p>
        <p>
          A join code is designed to be read out to a room, so consider who is in that room: anyone
          who uses the code is in the board. The owner can remove a member, revoke the link, lock
          editing, or turn on anonymous guests at any time.
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
          removes your account, every board saved under it, and all session records from the live
          database straight away, subject only to the fourteen-day backup window described under
          Retention. For anything else — access, correction, portability, or an objection — use the{' '}
          <a href="/contact" className="text-accent hover:underline">
            contact form
          </a>
          . Requests are answered within 30 days.
        </p>
        <p>
          <strong className="text-ink">
            One limit worth stating rather than discovering: a guest account cannot be verified.
          </strong>{' '}
          It has no address and no password, so there is no way to establish that a request about it
          comes from the person holding the browser it lives in. Deleting it from that browser
          works, and is the only route we can honour for it.
        </p>
        <p>
          If you are in the UK or the EU and you think this has been handled badly, you can complain
          to your data protection authority without going through us first. In the UK that is the{' '}
          <a
            href="https://ico.org.uk/make-a-complaint/"
            className="text-accent hover:underline"
            rel="noreferrer"
            target="_blank"
          >
            Information Commissioner's Office
          </a>
          ; in the EU it is the supervisory authority for the country you live in.
        </p>
      </Clause>

      <Clause heading="Retention, and what a backup means for it">
        <p>
          Your account and boards are kept until you delete them. Expired sessions are cleared
          automatically, as are password reset requests nobody completed. Messages sent through the
          contact form are kept until the exchange they are part of is finished.
        </p>
        <p>
          <strong className="text-ink">
            This section used to say there was no backup and that deletion was therefore final. That
            has stopped being true and the change is in your favour on one count and against you on
            another.
          </strong>{' '}
          There is now a nightly backup of the database, held on a different disk from the one the
          service runs on and copied off the machine. Fourteen days are kept, and each older copy is
          removed only once a newer one has been confirmed written.
        </p>
        <p>
          What that means for deletion: pressing <strong className="text-ink">Delete account</strong>{' '}
          removes the account, its boards and its sessions from the live database immediately, and
          they stop existing for every purpose the service has.{' '}
          <strong className="text-ink">
            A backup taken before you deleted may still contain a copy for up to fourteen days
          </strong>
          , after which it is gone with that backup. Backups are never read except to recover the
          whole service from a failure; nothing is restored out of one to look at an individual
          account. They carry the same encryption the live database does, so board contents in a
          backup are as unreadable without the key as they are in the database itself.
        </p>
        <p>
          The count in your favour is the obvious one: a disk failure used to mean everyone's boards
          were gone for good, and now it does not.
        </p>
      </Clause>

      <Clause heading="Who else touches any of this">
        <p>
          Your account and boards are held on hardware operated by the person who runs this
          installation, not on a cloud platform. Three other parties are involved, each in one
          narrow way, and this is the whole list:
        </p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong className="text-ink">Cloudflare</strong>, which carries the connection between
            your browser and the server and terminates HTTPS at its edge. It sees the traffic in
            the ordinary course of routing it, including your IP address. Nothing is stored there
            by us.{' '}
            <a
              href="https://www.cloudflare.com/privacypolicy/"
              className="text-accent hover:underline"
              rel="noreferrer"
              target="_blank"
            >
              Their privacy policy
            </a>
            .
          </li>
          <li>
            <strong className="text-ink">Google Drive</strong>, which holds the off-machine copy of
            the nightly backup described above. Board contents in it are encrypted, and the key is
            not in the backup.{' '}
            <a
              href="https://policies.google.com/privacy"
              className="text-accent hover:underline"
              rel="noreferrer"
              target="_blank"
            >
              Their privacy policy
            </a>
            .
          </li>
          <li>
            <strong className="text-ink">Google's Gemini API</strong>, and only if you turned the
            online assistant on, for the one message at a time described above.{' '}
            <a
              href="https://ai.google.dev/gemini-api/terms"
              className="text-accent hover:underline"
              rel="noreferrer"
              target="_blank"
            >
              Their API terms
            </a>
            .
          </li>
        </ul>
        <p>
          Any of these may process data outside your country, and where the UK or EU GDPR applies
          those transfers rest on the safeguards each provider publishes for its own service. There
          is no analytics provider, no advertising network, no CDN serving fonts or scripts, and{' '}
          <strong className="text-ink">no mail provider at all</strong> — nothing here sends email,
          which is why the contact form is a form.
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
          If you forget your password, your security question is what proves the account is yours.
          Answering it correctly issues a one-time reset token that is stored only as a hash and
          expires in 15 minutes. Wrong answers are limited: five lock the address for 15 minutes,
          and repeated attempts from one network are cut off sooner. Completing a reset signs out
          every session on the account, so a session somebody else took cannot outlive the password
          changed to stop it.
        </p>
        <p>
          <strong className="text-ink">
            If two-step sign-in is on, the answer alone is not enough to reset anything.
          </strong>{' '}
          A correct answer buys a five-minute prompt for a code, and only that code produces a reset
          token. That is deliberate: without it, the security question would be the cheapest way
          into the account and the second step would never be met by an attacker at all. Completing
          a reset does not turn two-step sign-in off.
        </p>
        <p>
          Be plain about the trade this makes. A question whose answer somebody close to you could
          guess is a weaker secret than a password, and the limits above are what stand between the
          two. Choose a question whose answer is not on your public profile, and treat the answer as
          another password rather than as a fact about you. Two-step sign-in is what puts a floor
          under it.
        </p>
        <p>
          Two-step sign-in is available and is off until you turn it on. With it on, signing in
          takes your password and then a code from an authenticator app, and no session is created
          between the two steps. Turning it on gives you ten recovery codes, shown once; each works
          a single time and they are the way back in if the phone is lost. Turning it off needs the
          password and a current code together. Codes are limited in the same way answers are: five
          wrong ones lock the account for 15 minutes.
        </p>
        <p>
          <strong className="text-ink">
            If you lose both your authenticator app and your recovery codes, nobody here can restore
            access to that account.
          </strong>{' '}
          There is no reset email anywhere in this product and no path that lets the security
          question skip the code, so there is nothing left to fall back on. Keep the recovery codes
          somewhere that is not the phone the app is on.
        </p>
        <p>
          Sessions last 30 days. Changing your password signs out every other session on the
          account, which is the way to end one you think somebody else is holding. Beyond HTTPS in
          transit and the encryption described above, treat a FootyBoard account as protecting
          tactical work rather than sensitive personal information.
        </p>
      </Clause>

      <Clause heading="Changes and contact">
        <p>
          If this policy changes materially, the date above changes and the new version applies from
          then. It is worth a look now and again; the entries above about backups and about what a
          room calls you are both corrections to what this page previously said, and both changed
          what was true rather than only how it was worded.
        </p>
        <p>
          Questions, and every request in this policy, go through the{' '}
          <a href="/contact" className="text-accent hover:underline">
            contact form
          </a>
          . Until August 2026 this page pointed at an address in the project's repository, and that
          repository is private — so the route it named reached nobody. The form is the fix.
        </p>
      </Clause>
    </LegalPage>
  )
}
