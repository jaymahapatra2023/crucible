import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * The two links participants need, as QR codes (E50).
 *
 * Registration and submission are the two public pages. On the day they are reached from a
 * phone pointed at a screen or a printed sheet, so each is rendered as a QR code beside the
 * address it encodes — generated here, in the browser, from the configured URL; no third-party
 * service ever sees the link. The configured `event.register_url` / `event.submit_url` are what
 * the emails use, so the QR and the email always say the same address; when unset, this
 * origin's own paths are shown and the panel says they are not yet configured.
 */
export function EventLinksPanel({
  registerUrl, submitUrl, canSave, busy, onSave,
}: {
  registerUrl: string | null
  submitUrl: string | null
  /** Only an admin may write config; the panel still shows the codes to everybody. */
  canSave: boolean
  busy: boolean
  onSave: (urls: { registerUrl: string; submitUrl: string }) => void
}) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const links = [
    { label: 'Register a team', configured: registerUrl, fallback: `${origin}/register` },
    { label: 'Submit an entry', configured: submitUrl, fallback: `${origin}/submit` },
  ]
  const unconfigured = links.some((l) => !l.configured)

  return (
    <section style={{ marginTop: 24 }} aria-labelledby="event-links-heading">
      <h2 id="event-links-heading" style={{ fontSize: 15 }}>Links for participants</h2>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {links.map((l) => <LinkCard key={l.label} label={l.label} url={l.configured ?? l.fallback} configured={l.configured !== null} />)}
      </div>
      {unconfigured && (
        <p role="status" style={{ fontSize: 13, color: 'var(--warn)' }}>
          The event URLs are not configured, so the codes above use this page's own address and
          the emails say "the submission page" instead of a link.
          {canSave && (
            <>
              {' '}
              <button type="button" disabled={busy}
                onClick={() => onSave({ registerUrl: `${origin}/register`, submitUrl: `${origin}/submit` })}>
                Use this address for both
              </button>
            </>
          )}
        </p>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        <button type="button" onClick={() => window.print()}>Print this page</button>
        {' '}— the codes print at a size a phone reads from across a table.
      </p>
    </section>
  )
}

function LinkCard({ label, url, configured }: { label: string; url: string; configured: boolean }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
      .then((s) => { if (live) setSvg(s) })
      .catch(() => { if (live) setSvg(null) })
    return () => { live = false }
  }, [url])

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)',
      width: 260, maxWidth: '100%',
    }}>
      <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{label}</h3>
      {svg ? (
        <img alt={`QR code for ${label}: ${url}`} width={220} height={220} style={{ display: 'block', maxWidth: '100%' }}
          src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} />
      ) : (
        <div style={{ width: 220, height: 220, background: 'var(--bg)' }} aria-hidden="true" />
      )}
      <p style={{ fontSize: 12, wordBreak: 'break-all', margin: '8px 0 4px' }}>
        <a href={url} target="_blank" rel="noreferrer">{url}</a>
        {!configured && <span style={{ color: 'var(--warn)' }}> (not configured)</span>}
      </p>
      <button type="button" style={{ fontSize: 12 }}
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
        }}>
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  )
}
