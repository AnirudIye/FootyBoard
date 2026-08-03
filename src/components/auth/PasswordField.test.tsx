import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PasswordField } from './PasswordField'

/**
 * The one password box the auth forms share, and the four things about it that
 * are easy to get wrong.
 *
 * A reveal toggle looks like a one-line change and is not. The button lives
 * inside a form, so it has to say it is not a submit; the state it carries is a
 * password in plain text, so it must not survive the field it belongs to; the
 * hint a password manager keys off has to come through untouched even though
 * the `type` under it changes; and a phone keyboard will capitalise the first
 * letter of a revealed password as you keep typing, which turns a feature for
 * catching typos into one that makes them.
 *
 * Each of those is asserted here rather than on the pages, because the pages get
 * this behaviour by using the component and there is no second copy of it.
 */

afterEach(cleanup)

const value = 'Prehnite!7712'

const at = (props: Partial<React.ComponentProps<typeof PasswordField>> = {}) =>
  render(<PasswordField label="Password" value={value} onChange={() => {}} {...props} />)

const box = () => screen.getByLabelText('Password') as HTMLInputElement
const show = () => screen.getByRole('button', { name: 'Show password' })
const hide = () => screen.getByRole('button', { name: 'Hide password' })

describe('PasswordField', () => {
  it('starts concealed', () => {
    at()
    expect(box().type).toBe('password')
    expect(show()).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the characters when asked, and says it is showing them', () => {
    at()
    fireEvent.click(show())

    expect(box().type).toBe('text')
    expect(hide()).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not clear or reorder what was typed', () => {
    // The whole point of the toggle is to check a password you are part way
    // through typing. A control that costs you the value has made things worse.
    at()
    fireEvent.click(show())
    expect(box().value).toBe(value)

    fireEvent.click(hide())
    expect(box().value).toBe(value)
    expect(box().type).toBe('password')
  })

  it('names itself rather than leaving that to an icon', () => {
    // The accessible name changes with the state, so somebody who cannot see the
    // field is told which way the toggle will move it rather than only that a
    // toggle exists.
    at()
    expect(screen.queryByRole('button', { name: 'Hide password' })).toBeNull()
    fireEvent.click(show())
    expect(screen.queryByRole('button', { name: 'Show password' })).toBeNull()
  })

  it('is a button and not a submit', () => {
    // A `<button>` inside a form defaults to `type="submit"`, so getting this
    // wrong means every attempt to look at your password posts the form.
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <PasswordField label="Password" value={value} onChange={() => {}} />
      </form>,
    )
    fireEvent.click(show())

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('never starts revealed, however the last one ended', () => {
    // Not state that survives navigation and not `localStorage`. The five
    // `soccerboard.` keys are preferences about a board; a password in plain
    // text on the next screen is not one.
    at()
    fireEvent.click(show())
    cleanup()

    at()
    expect(box().type).toBe('password')
    expect(show()).toBeInTheDocument()
  })

  it('writes nothing down', () => {
    at()
    fireEvent.click(show())

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('leaves the password manager hint exactly as it was given', () => {
    // Managers key off `autoComplete`, and a field that changes `type` under
    // them is already something they handle badly without the hint moving too.
    at({ autoComplete: 'new-password' })
    expect(box()).toHaveAttribute('autocomplete', 'new-password')
    fireEvent.click(show())
    expect(box()).toHaveAttribute('autocomplete', 'new-password')
  })

  it('keeps a phone keyboard from correcting a revealed password', () => {
    // A revealed field is a text field, and a text field on a phone gets an
    // auto-capitalised first letter and a spell checker. Both would edit the
    // password as it is being typed.
    at()
    fireEvent.click(show())

    expect(box()).toHaveAttribute('autocapitalize', 'off')
    expect(box()).toHaveAttribute('autocorrect', 'off')
    expect(box()).toHaveAttribute('spellcheck', 'false')
  })

  it('passes the rest of the input props through', () => {
    at({ required: true, placeholder: 'At least 8 characters', autoFocus: true })
    expect(box()).toBeRequired()
    expect(box()).toHaveAttribute('placeholder', 'At least 8 characters')
    expect(box()).toHaveFocus()
  })

  it('describes itself with a hint rather than swallowing it into the name', () => {
    // `TwoFactorPage` carries a sentence under its password box explaining why it
    // is being asked for. It used to sit inside the `<label>`, which made it part
    // of the input's accessible *name* — so a screen reader read the whole
    // sentence as the field's title every time it landed there. A description is
    // what it is, so `aria-describedby` is where it goes.
    at({ hint: 'Asked for so that a session somebody else is holding cannot be used.' })

    expect(box()).toHaveAccessibleName('Password')
    expect(box()).toHaveAccessibleDescription(
      'Asked for so that a session somebody else is holding cannot be used.',
    )
  })

  it('wires nothing up when there is no hint', () => {
    at()
    expect(box()).not.toHaveAttribute('aria-describedby')
  })

  it('gives two of them on one page separate labels and separate toggles', () => {
    // Signup renders a password and a confirm. Sharing an id would point both
    // labels at the first box, and sharing the reveal state would make a
    // "confirm" that shows you the answer you are meant to be re-typing.
    render(
      <>
        <PasswordField label="Password" value="one" onChange={() => {}} />
        <PasswordField label="Confirm" value="two" onChange={() => {}} />
      </>,
    )

    const first = screen.getByLabelText('Password') as HTMLInputElement
    const second = screen.getByLabelText('Confirm') as HTMLInputElement
    expect(first.id).not.toBe(second.id)

    fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0])
    expect(first.type).toBe('text')
    expect(second.type).toBe('password')
  })
})
