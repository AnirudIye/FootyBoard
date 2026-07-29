import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { SecurityQuestion } from '../../lib/api'
import { field } from './AuthShell'

/**
 * The question dropdown and its answer box, used by both places that set one:
 * creating an account, and changing a password.
 *
 * The list is fetched, never hardcoded. The server owns it and validates
 * against the same array, so a question can be added or reworded in one file
 * and both ends follow. A copy in here would be the second source of truth for
 * something that has one, and would fail quietly: the dropdown would offer an
 * id the server has never heard of and the form would answer "that is not one
 * of the security questions" to somebody who picked from the list we gave them.
 */
export function useSecurityQuestions() {
  const [questions, setQuestions] = useState<SecurityQuestion[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api
      .securityQuestions()
      .then((r) => live && setQuestions(r.questions))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])

  return { questions, failed }
}

export default function SecurityQuestionFields({
  questions,
  failed,
  questionId,
  onQuestionId,
  answer,
  onAnswer,
  note,
}: {
  questions: SecurityQuestion[]
  failed: boolean
  questionId: string
  onQuestionId: (id: string) => void
  answer: string
  onAnswer: (answer: string) => void
  note?: string
}) {
  return (
    <>
      <label className="block">
        <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
          Security question
        </span>
        {/* Deliberately not `disabled` while the list is loading or after it
            failed. A required select whose selected option has an empty value
            fails the browser's own validation, so leaving it enabled is what
            stops the form being submitted with no question chosen. Disabled
            controls are skipped by that check, which would have let a fast
            typist post an empty id and collect a 400 from the server. */}
        <select
          required
          value={questionId}
          onChange={(e) => onQuestionId(e.target.value)}
          className={field}
        >
          <option value="">
            {failed ? 'Could not load the questions' : 'Choose a question'}
          </option>
          {questions.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
          Answer
        </span>
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          value={answer}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="At least 3 characters"
          className={field}
        />
        {/* Said before it matters rather than after, because the thing people
            worry about is retyping it exactly. They do not have to. */}
        <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
          {note ??
            'Capitals and extra spaces are ignored, so you do not have to match how you typed it.'}
        </span>
      </label>
    </>
  )
}
