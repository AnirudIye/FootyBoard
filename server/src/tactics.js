/**
 * What the assistant knows about a shape, written down rather than recalled.
 *
 * The AI half can already answer a tactical question in prose, because the
 * prompt tells it to when the coach is asking rather than instructing. What it
 * could not do was answer *this* board's question: it knew nothing about the ten
 * presets `formations.ts` actually ships, so "how do I play against a 4-3-3"
 * got whatever a general model happens to hold about the phrase, which is
 * usually true, sometimes stale, and occasionally about a shape with different
 * personnel from the one drawn on the pitch.
 *
 * So the knowledge is data here, and the model composes rather than remembers.
 * Only the shapes actually in play are sent, which keeps the prompt short: see
 * `tacticalBrief`.
 *
 * **This is not a capability.** Nothing in this file can reach the board. It is
 * context appended to the system prompt, so the worst a wrong entry can do is
 * make the assistant say something wrong, which is the same thing a wrong prompt
 * line does. The capability boundary is still the function declarations in
 * `assistant.js`, and this adds nothing to them.
 *
 * **No em dashes.** The house rule covers anything a user reads, and every
 * sentence here is written to be quoted back at a coach. `clean()` in
 * `assistant.js` catches what the model writes; nothing catches what we feed it.
 */

/**
 * One entry per preset in `FORMATION_NAMES` in `src/lib/formations.ts`.
 *
 * That is a frontend module and this is a server one, so the list is matched by
 * hand the same way `ZONES` is in `assistant.js`. Unlike `ZONES` the drift is
 * *not* safe in either direction here, because a missing entry is silent: the
 * coach asks about a shape the board offers, gets no note, and the model falls
 * back on recall without anybody being told it did. `tactics.test.js` reads
 * `formations.ts` and fails if the two lists part company.
 */
export const TACTICS = {
  '4-4-2': {
    identity:
      'Two banks of four with a strike pair. The oldest defensive structure in the game, and still the most compact across the width.',
    strengths: [
      'the two flat lines cover the width with no gap between full-back and winger',
      'the strike pair can press two centre-backs two against two',
      'the distances are simple, so it is quick to coach and hard to pull apart',
      'the second striker is an immediate out ball when the ball is won',
    ],
    weaknesses: [
      'two central midfielders are outnumbered by a three',
      "the space between the midfield line and the back four is nobody's once the lines separate",
      'the wingers have to track all the way back or the full-backs defend one against one',
    ],
    against: [
      'overload the centre with a third midfielder, a dropping striker or an inverted winger, and play through the seam between the banks',
      'pin the wingers deep so the full-backs cannot join the attack',
      'switch quickly, because a flat four shifts as a unit and is slow to recover width',
    ],
    using: [
      'keep the two lines within about ten yards of each other and defend the centre before the flanks',
      'attack in wide pairs, full-back and winger, and hit the strikers early rather than working through the middle',
    ],
  },

  '4-3-3': {
    identity:
      'Back four, a midfield three built around a single holder, and a front three that holds the width.',
    strengths: [
      'triangles everywhere, so there is always a short pass on',
      'the front three pins the opposition back four and stops it stepping',
      'the wide forwards attack full-backs one against one in the last third',
      'the holder screens the centre-backs and lets both 8s run beyond',
    ],
    weaknesses: [
      'one holding midfielder in front of the back four, so a runner from deep or a body between the lines is hard to pick up',
      'the full-backs are exposed whenever the wide forwards stay high',
      'a side that keeps its width defends narrow badly',
    ],
    against: [
      'put a player between the lines either side of the holder and make the centre-backs decide whether to step',
      'attack the space behind the full-backs the moment they push on',
      'play a front two, so the holder has to pick one of them and the other is free',
    ],
    using: [
      'use the holder to protect the centre and send the two 8s past the ball',
      'keep the wide forwards on the touchline until the ball is ready to travel, then go one against one',
    ],
  },

  '4-2-3-1': {
    identity:
      'A double pivot with three behind a lone striker. The most common shape in the modern game, because it defends as a 4-4-1-1 and attacks as a 4-3-3.',
    strengths: [
      'two holders cover for each other, so one can step out without opening the middle',
      'the 10 occupies the hardest space on the pitch to mark',
      'it becomes a 4-4-2 or a 4-3-3 without a substitution',
    ],
    weaknesses: [
      'the striker presses alone and can be played around',
      'the pivot drops too deep under pressure and strands the 10',
      'the wide three cover long distances in both directions',
    ],
    against: [
      'build with three at the back, so one striker cannot cover both centre-backs',
      'get a midfielder into the gap outside the pivot, between it and the full-back',
      'break fast when the 10 loses the ball high, because the pivot is left two against three',
    ],
    using: [
      'keep one pivot player tight to the opposition 10 and use the other to start play',
      'support the striker quickly or they will be isolated with their back to goal',
    ],
  },

  '4-1-4-1': {
    identity: 'One holder, a flat four ahead of them, one striker. A defensive shape before it is anything else.',
    strengths: [
      'a bank of four plus a holder makes central penetration very hard',
      'the holder can mark a 10 man to man without the block losing shape',
      'the distances are short and the shape is easy to hold',
    ],
    weaknesses: [
      'the striker is isolated the moment the team has the ball',
      'a lot of ground between the holder and the front line',
      'pull the holder out and the whole middle opens',
    ],
    against: [
      'move the single holder with a false nine or a dropping 10, then run past them',
      'circulate wide, because the centre is closed',
      'keep two players high so the back four cannot step up',
    ],
    using: [
      'defend the middle, force the ball outside, then press the touchline as a trap',
      'get the wide midfielders forward fast in transition, because the striker cannot hold it alone for long',
    ],
  },

  '3-5-2': {
    identity: 'Back three, wing-backs holding the width, a midfield three and a strike pair.',
    strengths: [
      'three central midfielders and two strikers is an overload in the middle and against a back four at once',
      'the spare centre-back means a free man when playing out',
      'the wing-backs arrive from deep, where they are hard to track',
    ],
    weaknesses: [
      'one against one behind each wing-back the moment they push on',
      'against wide forwards it becomes a 5-3-2 and loses its midfield overload',
      'the wide centre-backs get dragged out of the back three',
    ],
    against: [
      'attack the space behind the wing-backs and make them defend rather than run',
      'use wide forwards to pin them, which turns the shape into a five and takes their midfield count away',
      'switch play quickly, because a back three has a long way to shuffle',
    ],
    using: [
      'get the wing-backs high early and keep the strike pair split so the centre-backs cannot double up',
      'let the free centre-back step into midfield when the press comes',
    ],
  },

  '3-4-3': {
    identity: 'Back three, a flat midfield four with wing-backs, and a front three.',
    strengths: [
      'the front three presses a back four man to man',
      'the width comes from wing-backs, so the forwards stay inside in dangerous areas',
      'a back three plays out under pressure with a spare man',
    ],
    weaknesses: [
      'only two central midfielders behind the front three, so the middle can be overrun',
      'enormous distances for the wing-backs in both directions',
      'the wide centre-backs defend the channel on their own',
    ],
    against: [
      'play three in central midfield and overload the two in the middle',
      'run a striker into the channel outside the wide centre-back',
      'break the moment they lose it high, because the back three is left square',
    ],
    using: [
      'press high and in one direction, because the shape only works when the front three sets the trap',
      'anchor one midfielder whenever the wing-backs push on',
    ],
  },

  '5-3-2': {
    identity: 'A back five, a midfield three and two strikers. A low block that intends to counter.',
    strengths: [
      'five across the back leaves no channel to run into',
      'the three in midfield still covers the centre behind them',
      'two strikers means the counter has an outlet without waiting',
    ],
    weaknesses: [
      'very little of the ball, so the strikers spend the game isolated',
      'the midfield three has to cover the whole width',
      'it invites pressure and can be pinned in for long spells',
    ],
    against: [
      'be patient and circulate to move the block, because running straight at it does not work',
      'push the full-backs high and overload one side to make it shift, then switch',
      'aim for the back post rather than the crowded middle',
    ],
    using: [
      'stay compact, deny the centre and force play backwards',
      'break with the two strikers the instant the ball is won, and do not chase it as a unit',
    ],
  },

  '5-4-1': {
    identity: 'Five at the back, four in midfield, one striker. The most defensive shape on this board.',
    strengths: [
      'lines of five and four leave almost no gap to play into',
      'the wide players double up on wingers immediately',
      'central penetration is close to impossible',
    ],
    weaknesses: [
      'almost no attacking outlet',
      'the lone striker can neither press nor hold the ball alone',
      'it concedes territory, and eventually that becomes pressure',
    ],
    against: [
      'overload a flank two against one and cross early, before the block sets',
      'shoot from the edge of the box, because the shape invites it and leaves that yard',
      'keep a midfielder high for the second ball',
    ],
    using: [
      'hold the two lines together and defend the width of the box, not the width of the pitch',
      'spring the counter through the wide midfielders and get runners past the striker fast',
    ],
  },

  '4-4-1-1': {
    identity: 'Two banks of four with a second striker sitting off the front man.',
    strengths: [
      'the 10 screens the opposition holder without the block losing its shape',
      'the compactness of a 4-4-2 with a body in the space between the lines',
      'it switches between pressing and sitting without changing personnel',
    ],
    weaknesses: [
      'still two in central midfield, so a three outnumbers them',
      'the 10 has to work both ways or the striker is alone',
      'the front two are far apart when the ball is won',
    ],
    against: [
      'play a third central midfielder past the two in the middle',
      "move the ball quickly out of the 10's cover shadow rather than through it",
      'attack the space the 10 vacates when they press',
    ],
    using: [
      'use the 10 to block the pass into the opposition holder and press outside them',
      'send the 10 beyond the striker sometimes, not only underneath',
    ],
  },

  '4-3-2-1': {
    identity: 'The christmas tree. Back four, a midfield three, two off the striker, and no natural width.',
    strengths: [
      'six central players including the striker, so the middle is very hard to play through',
      'excellent for counter-pressing centrally, because everybody is already there',
      'the two behind the striker live in the half-spaces, where full-back and centre-back both hesitate',
    ],
    weaknesses: [
      'no width at all without the full-backs, who must overlap all game',
      'it defends narrow, so a team that switches play will stretch it',
      'the striker is often alone in the box when the cross comes',
    ],
    against: [
      'use the width they hand you: switch to the far side and attack the full-back before they recover',
      'cross early, while their box is underloaded',
      'press the full-backs, because they are the only route forward wide',
    ],
    using: [
      'overlap with both full-backs at once and let the two behind the striker hold the half-spaces',
      'win it centrally and go straight through the middle before the shape resets',
    ],
  },

  // 7-a-side
  '2-3-1': {
    identity: 'Two at the back, three across midfield, one up. The standard 7-a-side shape.',
    strengths: [
      'three in midfield controls the middle of a small pitch',
      'the two defenders can split wide to play out',
      'the striker always has somebody arriving',
    ],
    weaknesses: [
      'only two defenders, so one break leaves them exposed',
      'the wide midfielders have to cover the whole flank alone',
    ],
    against: [
      'break through the middle before the three recover, and run at the two defenders in numbers',
      'play in behind rather than to feet, because there is no cover',
    ],
    using: [
      'keep the midfield three connected and rotate rather than all pushing on together',
      'use the striker to hold it while the midfield arrives',
    ],
  },

  // futsal
  '1-2-1': {
    identity: 'The diamond. A fixo at the back, two wide, a pivot up. The base futsal shape.',
    strengths: [
      'a body in every area of the court',
      'it rotates without losing its shape',
      'the fixo covers behind while the pivot pins the last defender',
    ],
    weaknesses: [
      'everything runs through the fixo, so pressing them high hurts',
      'the wide players cover the whole length of their side',
    ],
    against: [
      'press the fixo and force the ball wide',
      "cut the pass into the pivot's feet, because that is where every attack starts",
    ],
    using: [
      'rotate constantly so the diamond keeps its shape with different bodies in it',
      'play into the pivot and support off them immediately',
    ],
  },
}

/**
 * How many shapes get a note on one request.
 *
 * Three is what a question can actually be about: the shape asked about, and
 * the two on the board. Every note is roughly a hundred words, and the request
 * already carries up to 4000 characters of board description, so this is the
 * difference between a prompt that stays small and one that grows with whatever
 * digits happen to appear in a message.
 */
const MAX_BRIEFS = 3

/**
 * Every formation code in a piece of text, in the order it appears.
 *
 * The pattern is the one `detectFormation` uses in `src/lib/parser.ts`, so
 * "4231" and "4-2-3-1" and "4 2 3 1" all land on the same key. Only codes this
 * file has a note for survive, which is what makes it safe to run over a coach's
 * free text: a shirt number, a scoreline or a date cannot become a lookup.
 */
export function formationCodes(text) {
  const source = String(text ?? '')
  const pattern = /\b(\d)[-\s]?(\d)[-\s]?(\d)(?:[-\s]?(\d))?\b/g
  const found = []
  let match

  while ((match = pattern.exec(source))) {
    const digits = match.slice(1).filter(Boolean)
    let code = digits.join('-')

    // The fourth digit is taken greedily, and a space is a separator both
    // inside a code and between two of them: "4-3-3 4-4-2" reads as 4-3-3-4
    // first and loses both shapes. When the long reading is not a shape and the
    // short one is, take the short one and rescan from the digit it gave up.
    // That digit is the last character of the match, because the pattern ends
    // on a word boundary.
    if (digits.length === 4 && !(code in TACTICS) && digits.slice(0, 3).join('-') in TACTICS) {
      code = digits.slice(0, 3).join('-')
      pattern.lastIndex = match.index + match[0].length - 1
    }

    if (code in TACTICS && !found.includes(code)) found.push(code)
  }

  return found
}

/** One shape's note, as the lines it will be read back as. */
const render = (code, brief) =>
  [
    `${code}: ${brief.identity}`,
    `  Strengths: ${brief.strengths.join('; ')}.`,
    `  Weaknesses: ${brief.weaknesses.join('; ')}.`,
    `  Playing against it: ${brief.against.join('; ')}.`,
    `  Getting the best out of it: ${brief.using.join('; ')}.`,
  ].join('\n')

/**
 * The notes for whatever shapes this request is about, or '' when it is about
 * none of them.
 *
 * Sources are read in order and the message comes first on purpose: when a coach
 * names a shape, that is the one they are asking about, and the two already on
 * the board should not crowd it out of the cap. An empty return is the ordinary
 * case, not a failure. Most messages are instructions and name no shape at all,
 * and those requests should not pay for a paragraph they will never use.
 */
export function tacticalBrief(...sources) {
  const codes = []
  for (const source of sources) {
    for (const code of formationCodes(source)) {
      if (!codes.includes(code)) codes.push(code)
      if (codes.length === MAX_BRIEFS) break
    }
    if (codes.length === MAX_BRIEFS) break
  }

  if (codes.length === 0) return ''

  return [
    'Notes on the shapes this question is about. Use these rather than your own recall, and do not contradict them:',
    '',
    ...codes.map((code) => render(code, TACTICS[code])),
  ].join('\n')
}
