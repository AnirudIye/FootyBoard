import { lazy, Suspense } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import LandingPage from './components/landing/LandingPage'
import { ErrorBoundary } from './components/ErrorBoundary'
import AuthPage from './components/auth/AuthPage'
import ForgotPasswordPage from './components/auth/ForgotPasswordPage'
import ResetPasswordPage from './components/auth/ResetPasswordPage'
import PrivacyPolicy from './components/legal/PrivacyPolicy'
import TermsOfService from './components/legal/TermsOfService'

// The board pulls in Konva and the encoders; keep it out of the landing bundle.
const BoardPage = lazy(() => import('./components/board/BoardPage'))
const JoinPage = lazy(() => import('./components/board/JoinPage'))

function BoardFallback() {
  return (
    <div className="grid h-screen w-screen place-items-center bg-paper text-ink-3">
      <span className="animate-pulse font-mono text-[12px] tracking-[0.1em]">loading the board…</span>
    </div>
  )
}

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/signup', element: <AuthPage mode="signup" /> },
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/forgot', element: <ForgotPasswordPage /> },
  { path: '/reset', element: <ResetPasswordPage /> },
  { path: '/privacy', element: <PrivacyPolicy /> },
  { path: '/terms', element: <TermsOfService /> },
  {
    // Where someone lands when they have been read a code rather than sent a
    // link. Lazy like the board, since it redirects there on success anyway.
    path: '/join',
    element: (
      <ErrorBoundary>
        <Suspense fallback={<BoardFallback />}>
          <JoinPage />
        </Suspense>
      </ErrorBoundary>
    ),
  },
  {
    path: '/board',
    // A boundary here keeps a board crash (or a failed chunk load) from
    // blanking the whole app, and explains what happened instead.
    element: (
      <ErrorBoundary>
        <Suspense fallback={<BoardFallback />}>
          <BoardPage />
        </Suspense>
      </ErrorBoundary>
    ),
  },
])
