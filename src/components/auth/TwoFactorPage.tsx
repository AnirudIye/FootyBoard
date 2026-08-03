import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { useAuthStore, selectSignedIn, selectIsGuest } from '../../store/authStore'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'
import { PasswordField } from './PasswordField'

/**
 * The account's second factor: turning it on, seeing what is left, turning it
 * off.
 *
 * A page rather than a panel in the account popover, for the reason `/password`
 * is a page and more so: the moment this page exists for is ten recovery codes
 * on screen that will never be shown again, and 236px of popover is not where
 * somebody copies those down.
 *
 * **The ten codes are held in component state and nothing else reads them.** No
 * endpoint hands them back, so what is on screen is the only copy that will ever
 * exist. That is why nothing here navigates away on its own, why the button that
 * dismisses them says what it is claiming, and why the sentence above them is
 * the plainest one on the page.
 *
 * There is deliberately no QR code, and therefore no QR dependency. The
 * `otpauth://` link is better than a QR on the device somebody is already
 * holding, and every authenticator worth using accepts a typed secret. The cost
 * is named rather than hidden: on a desktop, with the app on a phone, this is 32
 * characters copied across from one screen to another, which is the worst moment
 * in the whole feature. The grouping into fours is what makes it survivable.
 */

/** `JBSW Y3DP EHPK 3PXP …`, because 32 unbroken characters cannot be retyped. */
const inFours = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret

/** What the two controls behind the password and a live code are asking for. */
type Pending = 'disable' | 'regenerate'

const quietButton =
  'w-full rounded border border-rule bg-sunken px-4 py-2.5 text-[14px] text-ink ' +
  'transition-colors duration-150 hover:border-rule-strong disabled:opacity-50 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent'

const linkish = 'text-accent underline underline-offset-2'

export default function TwoFactorPage() {
  const navigate = useNavigate()
  const signedIn = useAuthStore(selectSignedIn)
  /**
   * A guest is sent to claim their account, exactly as `/password` and
   * `/sessions` do it, and here the reason is structural rather than practical:
   * a factor sits behind the current password, `assertCurrentPassword` refuses a
   * guest by name, and a guest has no password to give. `POST /auth/2fa/enroll`
   * answers that with a 400 on `currentPassword` saying the account has none.
   * Showing them a password box and letting the server say so would be a dead
   * end; `Keep these boards` is the request they actually mean.
   */
  const isGuest = useAuthStore(selectIsGuest)
  const ready = useAuthStore((s) => s.ready)
  const restore = useAuthStore((s) => s.restore)

  const [status, setStatus] = useState<{ enabled: boolean; remainingRecoveryCodes: number } | null>(
    null,
  )
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null)
  /** The only copy that will ever exist, for as long as this render lasts. */
  const [codes, setCodes] = useState<string[] | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [turnedOff, setTurnedOff] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState<'secret' | 'codes' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Waiting for `ready` is what stops this bouncing everybody to the login page:
  // before the session has been checked, nobody looks signed in.
  useEffect(() => {
    if (!ready) return
    if (!signedIn) navigate('/login?next=/2fa', { replace: true })
    else if (isGuest) navigate('/claim', { replace: true })
  }, [ready, signedIn, isGuest, navigate])

  const load = useCallback(async () => {
    try {
      setStatus(await api.twoFactorStatus())
    } catch (err) {
      setError(toUserMessage(err, 'Could not read the state of two-step sign-in. Try again.'))
    }
  }, [])

  useEffect(() => {
    // Not for a guest and not for a visitor: both are about to be redirected,
    // and the server would refuse the call anyway.
    if (ready && signedIn && !isGuest) void load()
  }, [ready, signedIn, isGuest, load])

  /**
   * Ask the server who we are again, rather than editing the flag here.
   *
   * `twoFactorEnabled` is derived from `totp_confirmed_at` server-side, and the
   * account menu renders its label from the store copy. Writing `true` here
   * would be a second place that decides what "on" means, which is this repo's
   * most-repeated failure; refetching keeps the decision where it is made. It
   * also matters immediately: the menu is one client-side navigation away and
   * would otherwise go on offering to turn on a factor that is already on.
   */
  const settle = async () => {
    await restore()
    await load()
  }

  const beginEnrollment = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      setEnrollment(await api.beginTwoFactorEnrollment(currentPassword))
      setCurrentPassword('')
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Check your password and try again.'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A wrong code here keeps the person on this step, unlike at the sign-in form.
   *
   * There is no challenge to burn: this compares against a secret this account
   * generated for itself a moment ago, so it is an oracle for nothing and it
   * already sits behind the allowance the enroll call charged. Making somebody
   * re-enter their password and re-add the entry to their app over one mistyped
   * digit would be a cost with nothing bought by it.
   */
  const confirmEnrollment = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { recoveryCodes } = await api.confirmTwoFactorEnrollment(code)
      setCodes(recoveryCodes)
      setEnrollment(null)
      setCode('')
      await settle()
    } catch (err) {
      setError(toUserMessage(err, 'That code did not work. Check the app and try again.'))
    } finally {
      setBusy(false)
    }
  }

  const runPending = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (pending === 'disable') {
        await api.disableTwoFactor(currentPassword, code)
        setTurnedOff(true)
      } else {
        const { recoveryCodes } = await api.regenerateRecoveryCodes(currentPassword, code)
        setCodes(recoveryCodes)
      }
      setPending(null)
      setCurrentPassword('')
      setCode('')
      await settle()
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Check the details and try again.'))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (what: 'secret' | 'codes', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
    } catch {
      // Clipboard access can be refused, and the text is selectable either way.
      setError('Could not copy automatically. Select it and copy it by hand.')
    }
  }

  const backToBoard = (
    <p className="mt-5 text-[13px] text-ink-2">
      <Link to="/board" className={linkish}>
        Back to the board
      </Link>
    </p>
  )

  /**
   * The ten codes, and the only screen in the product that holds a credential
   * nothing can reissue. It takes over the page for that reason: there is
   * nothing else worth reading while these are on it.
   */
  if (codes) {
    return (
      <AuthShell title="Save your recovery codes">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Save these ten recovery codes now. This is the only time they are shown. Each one works
          once, and they are what gets you back in if you lose your authenticator.
        </p>

        <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-2 rounded border border-rule bg-sunken px-4 py-4">
          {codes.map((one) => (
            <li key={one} className="font-mono text-[13px] tracking-[0.04em] text-ink">
              {one}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => copy('codes', codes.join('\n'))}
          className={`mt-3 ${quietButton}`}
        >
          {copied === 'codes' ? 'Copied' : 'Copy all ten'}
        </button>

        {error && <div className="mt-4">{<FormError>{error}</FormError>}</div>}

        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={() => {
            setCodes(null)
            setCopied(null)
          }}
          className={`mt-4 ${submitBtn}`}
        >
          I have saved them
        </motion.button>

        <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          Keep them somewhere that is not the phone with your authenticator on it. If you lose both,
          nobody can restore access to this account.
        </p>
      </AuthShell>
    )
  }

  if (turnedOff) {
    return (
      <AuthShell title="Two-step sign-in is off">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Signing in is one step again, and your password and your security question are the only
          locks on this account. Your recovery codes have been deleted, and anywhere that was signed
          in is still signed in.
        </p>
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={() => {
            setTurnedOff(false)
            void load()
          }}
          className={`mt-6 ${submitBtn}`}
        >
          Turn it back on
        </motion.button>
        {backToBoard}
      </AuthShell>
    )
  }

  /** Step two of turning it on: the secret is out, and nothing is on yet. */
  if (enrollment) {
    return (
      <AuthShell title="Add it to your app">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Add this to your authenticator app, then type the code it shows to finish.
        </p>

        <p className="mt-5 text-[13px]">
          <a href={enrollment.uri} className={linkish}>
            Open in your authenticator app
          </a>
        </p>

        <div className="mt-4">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Or type this secret
          </span>
          {/* Mono and spaced in fours, because this is a readout being copied by
              hand rather than prose. The grouping is the difference between a
              retyped secret and an abandoned setup. */}
          <p className="select-all break-all rounded border border-rule bg-sunken px-3 py-2 font-mono text-[13px] leading-relaxed tracking-[0.08em] text-ink">
            {inFours(enrollment.secret)}
          </p>
          <button
            type="button"
            onClick={() => copy('secret', enrollment.secret)}
            className={`mt-2 ${quietButton}`}
          >
            {copied === 'secret' ? 'Copied' : 'Copy the secret'}
          </button>
        </div>

        <form onSubmit={confirmEnrollment} className="mt-6 space-y-4">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Code
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={19}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className={`${field} font-mono tracking-[0.18em]`}
            />
            <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
              The codes change every 30 seconds. If one is refused, wait for the next.
            </span>
          </label>

          {error && <FormError>{error}</FormError>}

          <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
            {busy ? 'Checking…' : 'Finish turning it on'}
          </motion.button>
        </form>

        <p className="mt-5 text-[13px] text-ink-2">
          Changed your mind?{' '}
          <button
            type="button"
            onClick={() => {
              setEnrollment(null)
              setCode('')
              setError(null)
            }}
            className={linkish}
          >
            Stop here
          </button>{' '}
          and nothing is turned on.
        </p>
      </AuthShell>
    )
  }

  /** The password and a live code, for the two controls that remove a factor. */
  if (pending) {
    const disabling = pending === 'disable'
    return (
      <AuthShell title={disabling ? 'Turn off two-step sign-in' : 'Replace your recovery codes'}>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          {disabling
            ? 'Turning this off means your password and your security question are the only locks on the account again.'
            : 'The ten you have now stop working the moment the new ten are made, whether or not you have used them.'}
        </p>

        <form onSubmit={runPending} className="mt-7 space-y-4">
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            required
            autoFocus
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />

          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Code
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={19}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className={`${field} font-mono tracking-[0.18em]`}
            />
            <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
              From your authenticator app, or one of your recovery codes.
            </span>
          </label>

          {/* Both are asked for, and the password alone would not do. A control
              that removed the factor behind the password would make the whole
              thing exactly as strong as the password, which is what it exists
              not to be. */}
          <p className="text-[12px] leading-relaxed text-ink-3">
            Both are asked for because this is the control that takes a lock off the account.
          </p>

          {error && <FormError>{error}</FormError>}

          <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
            {busy ? 'Working…' : disabling ? 'Turn it off' : 'Replace them'}
          </motion.button>
        </form>

        <p className="mt-5 text-[13px] text-ink-2">
          <button
            type="button"
            onClick={() => {
              setPending(null)
              setCurrentPassword('')
              setCode('')
              setError(null)
            }}
            className={linkish}
          >
            Leave it as it is
          </button>
        </p>
      </AuthShell>
    )
  }

  if (!status) {
    return (
      <AuthShell title="Two-step sign-in">
        <p className="mt-4 font-mono text-[12px] uppercase tracking-[0.1em] text-ink-3">
          checking…
        </p>
      </AuthShell>
    )
  }

  /** Already on: what is left, and the two ways to change it. */
  if (status.enabled) {
    const left = status.remainingRecoveryCodes
    return (
      <AuthShell title="Two-step sign-in">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Two-step sign-in is on. You have {left} recovery {left === 1 ? 'code' : 'codes'} left.
        </p>

        {/* At zero this is the strongest thing on the screen, and it has to be:
            no authenticator and no unused codes is the case that needs an
            operator, and the accepted cost of that is only acceptable if the
            person can see it coming. */}
        {left === 0 && (
          <p className="mt-4 rounded border border-accent/40 bg-[var(--accent-wash)] px-3 py-2 text-[13px] leading-relaxed text-ink">
            You have no recovery codes left. If you lose your authenticator now, nobody can restore
            access to this account. Get a new set.
          </p>
        )}

        {error && <div className="mt-4">{<FormError>{error}</FormError>}</div>}

        <div className="mt-6 space-y-3">
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => setPending('regenerate')}
            className={left === 0 ? submitBtn : quietButton}
          >
            Get a new set of recovery codes
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => setPending('disable')}
            className={quietButton}
          >
            Turn off two-step sign-in
          </motion.button>
        </div>

        <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          Changing your password does not ask for a code, deliberately: it already needs the
          password you are changing, and somebody whose phone has died still has to be able to
          change it.
        </p>

        {backToBoard}
      </AuthShell>
    )
  }

  /** Off: the argument for turning it on, and the password that starts it. */
  return (
    <AuthShell title="Two-step sign-in">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Add a code from an authenticator app to your password. Someone who learns your password
        still cannot sign in, and neither can someone who answers your security question.
      </p>

      <form onSubmit={beginEnrollment} className="mt-7 space-y-4">
        {/* The hint is `hint` rather than a span inside the label now, which is
            a change of meaning and not only of markup: inside the label it was
            part of the input's accessible *name*, so a screen reader read the
            whole sentence as the field's title every time focus landed there.
            `aria-describedby` says it after the name, which is what it is.

            The sentence itself is the strongest form of the argument the
            password change already makes: a session left open on a shared
            machine must not be enough to attach somebody else's authenticator,
            which is a lockout rather than a nuisance. */}
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          required
          autoFocus
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          hint="Asked for so that a session somebody else is holding cannot attach their app to your account."
        />

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Working…' : 'Set this up'}
        </motion.button>
      </form>

      <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
        You will be given ten recovery codes, shown once. They are the way back in if you lose the
        phone, and there is no reset email here to fall back on.
      </p>

      {backToBoard}
    </AuthShell>
  )
}
