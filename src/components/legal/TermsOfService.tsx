import LegalPage, { Clause } from './LegalPage'

const UPDATED = '27 July 2026'

export default function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" updated={UPDATED}>
      <Clause heading="Acceptance of these terms">
        <p>
          By creating an account or otherwise using FootyBoard, you agree to be bound by these
          terms. If you do not accept them, you must not use the service. Where you use FootyBoard
          on behalf of a club or other organisation, you confirm that you are authorised to accept
          these terms on its behalf.
        </p>
      </Clause>

      <Clause heading="Description of the service">
        <p>
          FootyBoard is a tactics board that runs in a web browser, with an optional account that
          saves your work. It is provided free of charge, without any commitment as to availability
          and without backups. You should export any board you wish to retain.
        </p>
      </Clause>

      <Clause heading="Your account">
        <p>
          Creating an account allows your boards to be saved and retrieved. You are responsible for
          maintaining the confidentiality of your password and for all activity that occurs under
          your account.
        </p>
        <p>
          If you forget your password, you may request a reset link by email. That link expires
          after a short period and may be used only once. Completing a reset signs out all existing
          sessions for the account. Deleting your account removes its boards immediately, and no
          backup is retained from which they could be restored.
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
          <li>upload or store content that you do not have the right to use.</li>
        </ul>
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
          While you are in a shared board, everyone else in it can see the email address on your
          account. That is how the presence list says who is present and whose cursor is whose.
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
          Nothing in these terms limits any liability that cannot be limited by law. This includes,
          for users in the United Kingdom, liability for death or personal injury caused by
          negligence and liability for fraud. Consumers in the United Kingdom and the European
          Union retain their statutory rights, and nothing in these terms overrides them.
        </p>
      </Clause>

      <Clause heading="Termination">
        <p>
          You may stop using the service at any time. Deleting your account removes it, and every
          board saved under it, from our server immediately and with no backup to restore from.
          Clearing your browser's site data signs you out and clears what is held on the device,
          but leaves a saved account as it was.
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

      <Clause heading="Contact">
        <p>
          Questions regarding these terms may be sent to the address published in the project's
          repository.
        </p>
      </Clause>
    </LegalPage>
  )
}
