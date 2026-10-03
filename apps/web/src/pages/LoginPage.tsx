import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { post } from '../lib/apiClient.js'
import { startSession, type SessionUser } from '../lib/session.js'
import { ErrorState } from '../components/ErrorState.js'

interface LoginResponse {
  token: string
  expiresIn: number
  user: SessionUser
}

/** Sign-in. The only unauthenticated page in the app. */
export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await post<LoginResponse>('/auth/login', { email, password })
      startSession(res.token, res.user)
      navigate('/runs', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ maxWidth: 360, margin: '48px auto' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Sign in to Crucible</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Evaluation tooling. Sign-in is required for everything except the published rubric.
      </p>

      {error && (
        <div style={{ margin: '16px 0' }}>
          <ErrorState title="Could not sign in" message={error} />
        </div>
      )}

      <form onSubmit={onSubmit}>
        <label htmlFor="email" style={labelStyle}>Email</label>
        <input
          id="email" type="email" required autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle}
        />

        <label htmlFor="password" style={labelStyle}>Password</label>
        <input
          id="password" type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle}
        />

        <button type="submit" disabled={busy} style={submitStyle}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  )
}

const labelStyle: React.CSSProperties = { display: 'block', marginTop: 12, fontWeight: 600 }
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', marginTop: 4,
  border: '1px solid var(--border)', borderRadius: 6, font: 'inherit',
}
const submitStyle: React.CSSProperties = {
  marginTop: 20, width: '100%', padding: '9px 12px', borderRadius: 6,
  border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff',
  font: 'inherit', fontWeight: 600, cursor: 'pointer',
}
