import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import { router } from './router'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAuthStore } from './store/authStore'

export default function App() {
  const restore = useAuthStore((s) => s.restore)

  // Ask the server who we are once, before anything decides whether to save.
  useEffect(() => {
    void restore()
  }, [restore])

  return (
    <ErrorBoundary>
      {/*
        The CSS block in tokens.css can only reach what the browser animates,
        and almost nothing in the board is animated by the browser: the chips,
        the panels and the frame strip all run through Framer Motion, which
        that block cannot see. This is the one line that reaches them, and
        "user" means it follows the system setting rather than overriding it.
        Transforms still apply instantly, so nothing moves to the wrong place;
        it is the travel between places that goes away.
      */}
      <MotionConfig reducedMotion="user">
        <RouterProvider router={router} />
      </MotionConfig>
    </ErrorBoundary>
  )
}
