import { useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { toUserMessage } from '../lib/errors'
import { useAuthStore } from '../store/authStore'
import { useBoardsStore } from '../store/boardsStore'
import { toast } from '../store/toastStore'

/**
 * Opening a board someone shared.
 *
 * The link is `/board?board=<id>&share=<token>`. Redeeming it makes the caller a
 * member and then opens the board, which is why this runs before the autosave
 * hook settles on which board to show — otherwise a shared link would flash the
 * board you had open last.
 *
 * Both parameters are stripped from the address bar afterwards. The token is a
 * credential, and leaving it in the URL means it survives in history, in a
 * screenshot, and in whatever the next page sends as a referrer.
 */
export function useShareLink() {
  const email = useAuthStore((s) => s.email)
  const ready = useAuthStore((s) => s.ready)
  const handled = useRef(false)

  useEffect(() => {
    if (!ready || handled.current) return

    const params = new URLSearchParams(window.location.search)
    const token = params.get('share')
    const board = params.get('board')
    if (!token && !board) return

    // Signing in has to come first — a share link grants access to an account,
    // so there must be an account to grant it to. Come back here afterwards.
    if (!email) {
      const next = encodeURIComponent(window.location.pathname + window.location.search)
      window.location.replace(`/login?next=${next}`)
      return
    }

    handled.current = true

    const clean = () => {
      params.delete('share')
      params.delete('board')
      const query = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''))
    }

    void (async () => {
      try {
        if (token) {
          const { board: joined } = await api.redeemShare(token)
          // The list has to be re-read: the board was not ours a moment ago, so
          // it is not in the picker yet.
          await useBoardsStore.getState().load()
          useBoardsStore.getState().select(joined.id)
          toast(`You joined "${joined.name}".`)
        } else if (board) {
          useBoardsStore.getState().select(board)
        }
      } catch (err) {
        toast(toUserMessage(err, 'That link is not valid any more.'))
      } finally {
        clean()
      }
    })()
  }, [email, ready])
}
