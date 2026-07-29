import { lazy, Suspense } from 'react'
import { Outlet, createBrowserRouter } from 'react-router-dom'
import type { RouteObject } from 'react-router-dom'
import LandingPage from './components/landing/LandingPage'
import { ErrorBoundary } from './components/ErrorBoundary'
import { NotFound, RouteError } from './components/NotFound'
import AuthPage from './components/auth/AuthPage'
import ForgotPasswordPage from './components/auth/ForgotPasswordPage'
import ResetPasswordPage from './components/auth/ResetPasswordPage'
import ChangePasswordPage from './components/auth/ChangePasswordPage'
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

/**
 * Exported so the suite can mount them in a memory router. The app's own router
 * is a browser router and cannot be pointed at an arbitrary path from a test.
 *
 * Every page hangs off one pathless parent, which exists only to own
 * `errorElement`. Without it React Router answers a thrown error from its
 * built-in default boundary, and that boundary is a developer's screen that
 * ships to production unchanged. The two halves are deliberate and cover
 * different failures: the catch-all answers an address that matches nothing,
 * and `errorElement` answers anything a matched route throws on the way to
 * rendering.
 */
export const routes: RouteObject[] = [
  {
    element: <Outlet />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/signup', element: <AuthPage mode="signup" /> },
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/forgot', element: <ForgotPasswordPage /> },
      { path: '/reset', element: <ResetPasswordPage /> },
      { path: '/password', element: <ChangePasswordPage /> },
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
        // blanking the whole app, and explains what happened instead. It sits
        // inside the element rather than on the route so it catches nearer to
        // the failure and can offer the reload that usually fixes it.
        element: (
          <ErrorBoundary>
            <Suspense fallback={<BoardFallback />}>
              <BoardPage />
            </Suspense>
          </ErrorBoundary>
        ),
      },
      // Last, and matching everything left over.
      { path: '*', element: <NotFound /> },
    ],
  },
]

export const router = createBrowserRouter(routes)
