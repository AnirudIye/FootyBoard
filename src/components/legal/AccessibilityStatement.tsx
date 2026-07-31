import LegalPage, { Clause } from './LegalPage'

const UPDATED = '30 July 2026'

/**
 * What this product actually does for people with access needs, and what it
 * does not.
 *
 * **Written from the code rather than from intention**, which is the whole
 * reason it reads the way it does. An accessibility statement is the easiest
 * document in a repository to fill with things that sound true: "we follow WCAG
 * 2.2 AA", "the app is fully keyboard accessible", "we test with screen
 * readers". None of those are true here, two of them cannot be true while the
 * board is a canvas, and publishing them would be the exact failure this
 * codebase keeps finding in itself, where a description of intent and a
 * description of behaviour look identical on the page.
 *
 * So every claim below points at something in the source, and the shortfalls
 * are named rather than left for somebody to discover. If a claim here stops
 * being true, take it out rather than softening it.
 */
export default function AccessibilityStatement() {
  return (
    <LegalPage title="Accessibility" updated={UPDATED}>
      <Clause heading="The short version">
        <p>
          The pages around the board are ordinary web pages and behave like them. The board itself
          is drawn on a canvas, which means a screen reader cannot see what is on it, and moving a
          player needs a pointer. That is a real limit rather than an oversight, and this page says
          where it bites and what we do about the parts we can reach.
        </p>
        <p>
          We have not been independently audited and we do not claim conformance with WCAG 2.2 at
          any level. What follows is what the software does today.
        </p>
      </Clause>

      <Clause heading="Motion">
        <p>
          If your system is set to reduce motion, FootyBoard follows it. Animations do not play:
          things arrive where they were going instead of travelling there. That covers the chips,
          the panels, the frame strip, the formation glide, the pitch morph, zoom-to-fit, and the
          smooth scrolling in the assistant panel.
        </p>
        <p>
          Nothing on the board flashes, and there is no autoplaying video or audio anywhere in the
          product. Frame playback only runs while you ask it to.
        </p>
      </Clause>

      <Clause heading="The keyboard">
        <p>Once something is selected, the board can be driven from the keyboard:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong className="text-ink">Arrow keys</strong> nudge the selection, and holding Shift
            makes each step larger.
          </li>
          <li>
            <strong className="text-ink">Ctrl or Cmd with Z</strong> undoes, and with Shift it
            redoes. Ctrl or Cmd with Y also redoes.
          </li>
          <li>
            <strong className="text-ink">Ctrl or Cmd with D</strong> duplicates, and with A selects
            every player.
          </li>
          <li>
            <strong className="text-ink">Delete or Backspace</strong> removes the selection, and
            Escape clears it.
          </li>
          <li>
            <strong className="text-ink">F</strong> fits the pitch to the window, and holding Space
            turns a drag into a pan.
          </li>
        </ul>
        <p>
          Every one of those is withheld while you are typing in a field, so Escape in a name box
          means leave the box rather than put the tool away.
        </p>
        <p>
          <strong className="text-ink">What is missing, plainly:</strong> there is no way to select
          an individual player from the keyboard. Selection is a click, a marquee, or Ctrl and A,
          so the shortcuts above are reachable but the first step to them is not. Somebody who
          cannot use a pointer can select all the players and move them together, and cannot pick
          one out.
        </p>
      </Clause>

      <Clause heading="Screen readers">
        <p>
          The landing page, the account pages, the join page and these policy pages are built from
          ordinary HTML. Buttons are buttons, links are links, the toolbar's toggles report whether
          they are on, decorative marks are hidden from assistive technology, and the controls that
          are icons alone carry labels.
        </p>
        <p>
          <strong className="text-ink">The pitch is not any of that.</strong> It is a canvas, so
          the players, the ball, the arrows and the zones are pixels rather than elements. A screen
          reader reaches the toolbar, the panels and the dialogs around it and finds nothing inside
          it. There is no text alternative describing the current shape of a board, and we are not
          going to pretend a one line label would be one. If you need the contents of a board in a
          form a screen reader can read, we do not have that today.
        </p>
      </Clause>

      <Clause heading="Colour and contrast">
        <p>
          FootyBoard has a dark theme and a light one, and it follows your system setting unless
          you tell it otherwise. The control is under Appearance in the board's top bar. Body text
          and interface labels clear the WCAG AA contrast floor on both, and the smallest labels in
          the product were checked against every surface they sit on rather than against the page
          background alone. The save indicator's warning states were deliberately moved onto their
          own colour so that they stay legible whatever a team is wearing.
        </p>
        <p>
          Two things the setting deliberately does not change. The marketing page keeps its dark
          treatment, because it is built out of effects that have no light equivalent. And the
          pitch keeps its own look, which is saved with the board and shared with everyone in the
          room, so your choice of theme never changes what somebody else sees or what an export
          looks like.
        </p>
        <p>
          The two team colours are a muted brick and a muted navy, chosen to stay distinguishable
          for the common forms of colour blindness. Colour is never the only thing carrying
          meaning: players have shirt numbers, and formation labels are written out.
        </p>
        <p>
          <strong className="text-ink">One known shortfall:</strong> the small team colour dots on
          the landing page sit at about 3.6 to 1 and 2.8 to 1 against the page background, and the
          second of those is under the 3 to 1 that WCAG asks of meaningful non-text. Each of those
          dots sits beside a written label that says the same thing, so nothing is only available
          as a colour, but the marks themselves are below the line and we would rather say so than
          not.
        </p>
      </Clause>

      <Clause heading="Zoom and text size">
        <p>
          The pages around the board reflow rather than scrolling sideways, and they respect the
          text size set in your browser. The board has its own zoom, on the scroll wheel and on the
          F key, which is independent of the browser's.
        </p>
      </Clause>

      <Clause heading="Where we know we fall short">
        <p>Gathered in one place rather than spread through the page:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>The board's contents are invisible to a screen reader.</li>
          <li>An individual player cannot be selected without a pointer.</li>
          <li>The marketing page is dark only, whatever your theme setting says.</li>
          <li>Two decorative colour dots on the landing page are below the contrast floor.</li>
          <li>Nothing here has been checked by an independent auditor.</li>
        </ul>
      </Clause>

      <Clause heading="Telling us about a problem">
        <p>
          If something here blocks you, we want to hear about it, including the things this page
          already admits to. Say what you were trying to do and what got in the way, and if you use
          assistive technology, which one and which browser. We will tell you honestly whether it
          is something we can fix and roughly when.
        </p>
      </Clause>
    </LegalPage>
  )
}
