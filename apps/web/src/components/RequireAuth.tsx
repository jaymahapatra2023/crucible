import { useSyncExternalStore, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { getUserSnapshot, subscribeToSession } from '../lib/session.js'

/**
 * Route guard.
 *
 * Client-side only, and deliberately not treated as security: the server authorises every
 * request independently (P8.5 — no layer trusts the layer above it). This exists so a signed-out
 * user sees the sign-in page instead of a wall of 401 errors (P5.4). It subscribes to the session
 * store, so a session the API refuses mid-page (expired, revoked) returns to sign-in at once rather
 * than leaving the person on a page of errors.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  const user = useSyncExternalStore(subscribeToSession, getUserSnapshot, getUserSnapshot)
  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}
