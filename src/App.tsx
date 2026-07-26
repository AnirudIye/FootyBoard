import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
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
      <RouterProvider router={router} />
    </ErrorBoundary>
  )
}
