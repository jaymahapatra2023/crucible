import { useNavigate } from 'react-router-dom'
import { endSession, getUser } from '../lib/session.js'

/** Shows who is signed in and their role — P5.2's role-appropriate context, always visible. */
export function SessionBar() {
  const user = getUser()
  const navigate = useNavigate()
  if (!user) return null

  return (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>
        {user.displayName} · <strong>{user.role}</strong>
      </span>
      <button
        type="button"
        onClick={() => {
          endSession()
          navigate('/login', { replace: true })
        }}
        style={{
          border: '1px solid var(--border)', background: 'var(--surface)',
          borderRadius: 6, padding: '4px 10px', cursor: 'pointer', font: 'inherit',
        }}
      >
        Sign out
      </button>
    </div>
  )
}
