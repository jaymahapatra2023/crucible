import { useSyncExternalStore, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { SessionBar } from './SessionBar.js'
import { getUserSnapshot, subscribeToSession } from '../lib/session.js'

const NAV = [
  { to: '/challenges', label: 'Challenges' },
  { to: '/intake', label: 'Intake' },
  /*
   * The team-facing entry form, reachable from the staff chrome.
   *
   * It is the one page that needs no account, so an organiser opening it is looking at exactly
   * what a team sees — which is the point: the screen forty people will use on the night should
   * not be the one screen nobody with an account ever visits.
   *
   * It is NOT the path for an organiser entering on a team's behalf. That lives on Intake and
   * needs no token; this form asks for one, because a token is how a team without an account
   * proves which team it is.
   */
  { to: '/submit', label: 'Submit' },
  // The other participant-facing screen, for the same reason: staff can see what entrants see.
  { to: '/register', label: 'Register' },
  { to: '/roster', label: 'Roster', minRole: 'organiser' },
  { to: '/scoring', label: 'Scoring' },
  { to: '/catalogue', label: 'Principles' },
  { to: '/calibration', label: 'Calibration' },
  { to: '/runs', label: 'Runs' },
  { to: '/health', label: 'Health' },
]

/** The two pages a participant uses. Signed out, these are the whole navigation (E44-S04). */
/** Role rank, matching the API's requireRole ordering. */
const RANK: Record<string, number> = { viewer: 0, reviewer: 1, organiser: 2, admin: 3 }
const PUBLIC_NAV = NAV.filter((item) => item.to === '/register' || item.to === '/submit')

/**
 * Application chrome. Navigation is a real landmark with an accessible name (P5.5).
 *
 * Signed out — a participant on a phone — the header shows only the two public pages: no
 * staff links that imply an account they do not have. Signed in, every page, wrapping onto a
 * second row on a narrow screen rather than overflowing off it (E50).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const user = useSyncExternalStore(subscribeToSession, getUserSnapshot, getUserSnapshot)
  const items = user ? NAV.filter((item) => !('minRole' in item) || (RANK[user.role] ?? 0) >= (RANK[item.minRole as string] ?? 0)) : PUBLIC_NAV
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '4px 16px',
          minHeight: 52,
        }}
      >
        <strong style={{ fontSize: 15, letterSpacing: '-0.01em' }}>Crucible</strong>
        <nav aria-label="Primary" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className="nav-link"
              style={({ isActive }) => ({
                display: 'inline-flex', alignItems: 'center',
                padding: '6px 10px',
                borderRadius: 6,
                textDecoration: 'none',
                color: isActive ? 'var(--text)' : 'var(--text-muted)',
                background: isActive ? 'var(--bg)' : 'transparent',
                fontWeight: isActive ? 600 : 400,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <SessionBar />
      </header>
      <main style={{ flex: 1, padding: 20, maxWidth: 1400, width: '100%', margin: '0 auto' }}>
        {children}
      </main>
    </div>
  )
}
