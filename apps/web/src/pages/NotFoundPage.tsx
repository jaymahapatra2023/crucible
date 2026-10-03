import { Link } from 'react-router-dom'
import { getUser } from '../lib/session.js'

/**
 * An address the app does not serve (P5.4): say so, and offer the way back — to the app for
 * staff, to the two public pages for a participant who mistyped a link under time pressure.
 */
export function NotFoundPage() {
  const signedIn = getUser() !== null
  return (
    <section role="alert" aria-live="polite" style={{ maxWidth: 520 }}>
      <h1 style={{ fontSize: 19 }}>There is nothing at this address</h1>
      <p style={{ color: 'var(--text-muted)' }}>
        The link may be out of date or mistyped. Nothing was changed.
      </p>
      <p>
        {signedIn
          ? <Link to="/runs">Go to the app</Link>
          : <><Link to="/register">Register a team</Link> · <Link to="/submit">Submit an entry</Link></>}
      </p>
    </section>
  )
}
