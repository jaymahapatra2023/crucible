/**
 * Client-side session.
 *
 * The token lives in `sessionStorage`, not `localStorage`: an evaluation session should not
 * outlive the browser tab on a shared machine, and the server-side token expiry (8 hours) is
 * the real bound either way.
 */
export interface SessionUser {
  userId: string
  email: string
  displayName: string
  role: 'admin' | 'organiser' | 'reviewer' | 'viewer'
}

const TOKEN_KEY = 'crucible.token'
const USER_KEY = 'crucible.user'

const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function subscribeToSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Storage can throw in private-browsing modes; a session read must never break the app. */
function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function getToken(): string | null {
  return safeGet(TOKEN_KEY)
}

export function getUser(): SessionUser | null {
  const raw = safeGet(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionUser
  } catch {
    return null
  }
}

/**
 * The same user as a STABLE reference, for `useSyncExternalStore`.
 *
 * `getUser` parses storage on every call and so returns a fresh object each time; a store
 * snapshot that is never `===` its previous value makes React re-render without end ("the
 * result of getSnapshot should be cached"). This caches the parsed user against the raw string
 * it came from, so the reference changes only when the session does.
 */
let cachedRaw: string | null = null
let cachedUser: SessionUser | null = null

export function getUserSnapshot(): SessionUser | null {
  const raw = safeGet(USER_KEY)
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedUser = getUser()
  }
  return cachedUser
}

export function startSession(token: string, user: SessionUser): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
    sessionStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    // Non-persistent session: the app still works for this page load.
  }
  notify()
}

export function endSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
  } catch {
    // Nothing to clear.
  }
  notify()
}

export function isSignedIn(): boolean {
  return getToken() !== null
}
