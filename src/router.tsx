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
import TwoFactorPage from './components/auth/TwoFactorPage'
import DeleteAccountPage from './components/auth/DeleteAccountPage'
import DisplayNamePage from './components/auth/DisplayNamePage'
import SignOutEverywherePage from './components/auth/SignOutEverywherePage'
import ClaimPage from './components/auth/ClaimPage'
import PrivacyPolicy from './components/legal/PrivacyPolicy'
import TermsOfService from './components/legal/TermsOfService'
import AccessibilityStatement from './components/legal/AccessibilityStatement'

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
      // The second factor. A page beside `/password` rather than a panel in the
      // account popover, because the moment it exists for is ten recovery codes
      // on screen that no endpoint will ever hand back, and 236px is not where
      // anybody copies those down. Closed to a guest, like `/password`: a factor
      // sits behind the current password and a guest has none.
      { path: '/2fa', element: <TwoFactorPage /> },
      // Deleting the account. A page for the reason `/sessions` is one: it now
      // takes the current password, and a code when the factor is on, and a
      // native confirm cannot collect either. Open to a guest, unlike
      // `/password`: nothing here is a credential change, and the privacy policy
      // promises deletion to everybody without excepting an account that has no
      // address.
      { path: '/delete-account', element: <DeleteAccountPage /> },
      // What a room calls you. Open to a guest, unlike `/password`: a display
      // name is not a credential, and a guest with no address is exactly who
      // gains most from having one.
      { path: '/name', element: <DisplayNamePage /> },
      // Ending every session without changing the password. A page rather than a
      // control on the board, because it closes the caller's own room, and a
      // board still mounted reports that as a session that has ended.
      { path: '/sessions', element: <SignOutEverywherePage /> },
      // Where a guest turns the account their join code made into one they can
      // sign back into. Not `/signup`: that would make a second account and
      // leave their boards on the first.
      { path: '/claim', element: <ClaimPage /> },
      { path: '/privacy', element: <PrivacyPolicy /> },
      { path: '/terms', element: <TermsOfService /> },
      { path: '/accessibility', element: <AccessibilityStatement /> },
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
