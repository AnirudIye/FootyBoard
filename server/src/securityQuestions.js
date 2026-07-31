import { createHmac, randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from './auth.js'
import { BadRequest } from './validate.js'
import { SESSION_SECRET } from './env.js'

/**
 * The security question, which is what proves identity when a password is
 * forgotten.
 *
 * There is no reset email any more, so this file is the whole authenticator.
 * Four things make that defensible rather than a back door:
 *
 *   - the answer is stored the way the password is, as an scrypt digest with a
 *     per-user salt, compared in constant time. Nothing here can read it back;
 *   - both the set path and the verify path normalise through *one* function,
 *     so the two cannot drift. They are the only callers of `normalizeAnswer`;
 *   - the list of questions lives here and only here. The client fetches it, so
 *     there is no second copy to fall out of step;
 *   - and an address nobody has an account for still gets a question, derived
 *     from the address itself, so asking is not a way to find out who is
 *     registered.
 *
 * Verifying an answer is rate limited in `rateLimit.js`, which is the control
 * that actually makes a short, guessable secret safe to hold a password behind.
 */

/**
 * The canonical list. Ids are stored in the users row in plain text, because
 * which question someone picked is not a secret; the answer is.
 *
 * Ids are what is written down, so they are stable strings rather than
 * positions: reordering or removing a line here must never silently repoint an
 * existing account at a different question.
 */
export const SECURITY_QUESTIONS = [
  { id: 'first-pet', label: 'What was the name of your first pet?' },
  { id: 'childhood-street', label: 'What street did you live on as a child?' },
  { id: 'first-school', label: 'What was the name of your first school?' },
  { id: 'first-club', label: 'Which football club did you support first?' },
  { id: 'childhood-friend', label: 'What is the first name of your oldest friend?' },
  { id: 'favourite-teacher', label: 'What was the name of your favourite teacher?' },
  { id: 'first-job-town', label: 'In which town did you have your first job?' },
  { id: 'childhood-nickname', label: 'What was your childhood nickname?' },
  { id: 'first-concert', label: 'Who did you see play at your first live concert?' },
  { id: 'first-trip', label: 'Where did you go on your first trip abroad?' },
]

const BY_ID = new Map(SECURITY_QUESTIONS.map((q) => [q.id, q]))

export const isKnownQuestion = (id) => BY_ID.has(id)

/** The text for an id, or null. Used to answer step one of recovery. */
export const questionLabel = (id) => BY_ID.get(id)?.label ?? null

const MIN_ANSWER = 3
const MAX_ANSWER = 200

/**
 * The single normaliser, called on the way in at set time and again at verify
 * time. It has exactly two callers, `hashAnswer` and `verifyAnswer`, and that
 * is deliberate: if the two paths ever normalised differently nobody could
 * recover an account, and nothing would say so. The failure would be silent,
 * total, and only visible to the person locked out.
 *
 * People do not retype a secret the way they first typed it. Case is dropped,
 * the ends are trimmed, and runs of internal whitespace collapse to one space,
 * so " Blue  Sky " and "blue sky" are the same answer. Control characters go
 * for the same reason they go everywhere else a field is accepted.
 */
export const normalizeAnswer = (raw) =>
  String(raw ?? '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')

/** The question id, checked against the list rather than trusted. */
export function validateSecurityQuestionId(raw) {
  if (typeof raw !== 'string')
    throw new BadRequest('Choose a security question.', 'securityQuestionId')
  if (!isKnownQuestion(raw))
    throw new BadRequest('That is not one of the security questions.', 'securityQuestionId')
  return raw
}

/**
 * The answer, judged after normalisation rather than before it, because the
 * normalised form is the thing that will actually be stored and compared. Three
 * spaces is not a two-character answer padded out, it is an empty one.
 */
export function validateSecurityAnswer(raw) {
  if (typeof raw !== 'string')
    throw new BadRequest('Answer your security question.', 'securityAnswer')
  const answer = normalizeAnswer(raw)
  if (answer.length < MIN_ANSWER)
    throw new BadRequest(
      `Use an answer of at least ${MIN_ANSWER} characters.`,
      'securityAnswer',
    )
  if (answer.length > MAX_ANSWER)
    throw new BadRequest(`Use an answer shorter than ${MAX_ANSWER} characters.`, 'securityAnswer')
  return raw
}

/**
 * Hashing and checking both go through the password helpers rather than a
 * second implementation. Same scrypt parameters, same per-user salt, same
 * `timingSafeEqual` on the way back: a second copy of this is a second chance
 * to get a constant-time comparison wrong.
 */
export const hashAnswer = (raw) => hashPassword(normalizeAnswer(raw))

export const verifyAnswer = (raw, salt, expectedHex) =>
  verifyPassword(normalizeAnswer(raw), salt, expectedHex)

/**
 * Something to compare against when there is nothing to compare against.
 *
 * An address with no account, and an account predating this feature, both have
 * no stored answer. Skipping the comparison for them would answer in a
 * millisecond where a real account takes the tens of milliseconds scrypt costs,
 * and that difference is readable over a network: the endpoint would go back to
 * being an account oracle by the clock instead of by the wording.
 *
 * The digest is the wrong length on purpose. `verifyPassword` derives the key
 * before it can notice, so the work is spent, and the answer is false.
 */
export const DECOY_ANSWER = { salt: randomBytes(16).toString('hex'), hash: 'ff' }

/**
 * The question an address gets when it has no account, or has one from before
 * this existed.
 *
 * Saying "no such account" here, or answering with a different shape, would
 * make step one of recovery a way to test which addresses are registered, which
 * is exactly the property the old flow's deliberately generic replies existed to
 * protect. So every address gets a question.
 *
 * It has to be *stable*, or probing the same address twice would show a
 * different question each time and give the game away just as plainly. Deriving
 * it from an HMAC of the address gives a fixed answer per address without
 * storing a row for every stranger anyone types in, and keying that HMAC on
 * SESSION_SECRET stops an attacker computing the mapping offline and spotting
 * the accounts whose question does not match the one their own arithmetic
 * predicts.
 *
 * Read through `env.js` rather than off `process.env` here, because that is
 * where the floor lives: production refuses to boot on the committed
 * placeholder, precisely so this key cannot be the public one.
 */
const HMAC_KEY = `security-question:${SESSION_SECRET}`

export function derivedQuestionId(email) {
  const mac = createHmac('sha256', HMAC_KEY).update(email).digest()
  return SECURITY_QUESTIONS[mac.readUInt32BE(0) % SECURITY_QUESTIONS.length].id
}

/**
 * What step one of recovery answers with, for anybody who asks.
 *
 * A real question for a real account, and a derived one otherwise. A stored id
 * that is no longer in the list falls back to the derived question rather than
 * returning nothing, because a null here would be the leak in a different
 * costume.
 */
export function questionFor(email, storedId) {
  const id = storedId && isKnownQuestion(storedId) ? storedId : derivedQuestionId(email)
  return { id, label: questionLabel(id) }
}
