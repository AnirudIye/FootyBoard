import { Component } from 'react'
import type { ReactNode } from 'react'
import { toUserMessage } from '../lib/errors'

interface Props {
  children: ReactNode
}

interface State {
  error: unknown
}

/**
 * Catches a render crash and explains it, instead of leaving a blank screen.
 * Offers a way out: reload, or clear the saved board — a stored board that
 * triggers the crash on every load would otherwise be unrecoverable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  private reload = () => window.location.reload()

  private startFresh = () => {
    try {
      localStorage.removeItem('soccerboard.board')
    } catch {
      // Storage is unreadable; reloading is still worth a try.
    }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    const detail = toUserMessage(
      this.state.error,
      'The board hit a problem it could not recover from.',
    )

    return (
      <div className="grid min-h-screen w-full place-items-center bg-paper px-5 text-ink">
        <div className="w-full max-w-md rounded-lg border border-rule bg-surface p-6 shadow-2">
          <span className="font-mono text-[11px] tracking-[0.16em] text-accent">
            THE BOARD STOPPED
          </span>
          <h1 className="mt-3 font-display text-[20px] font-semibold tracking-[-0.02em]">
            Something on the board broke.
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{detail}</p>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            A reload usually sorts it. If it breaks again the moment it opens, start fresh instead.
            That wipes the saved board on this device, so only do it if the reload didn't work.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={this.reload}
              className="rounded bg-accent px-3.5 py-2 text-[13px] font-medium text-[#fbf9f5]
                transition-colors duration-150 hover:bg-accent-hover
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                focus-visible:outline-accent"
            >
              Reload the board
            </button>
            <button
              onClick={this.startFresh}
              className="rounded border border-rule bg-surface px-3.5 py-2 text-[13px] font-medium
                text-ink transition-colors duration-150 hover:border-rule-strong
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                focus-visible:outline-accent"
            >
              Start a fresh board
            </button>
          </div>
        </div>
      </div>
    )
  }
}
