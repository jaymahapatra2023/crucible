import type { Finding } from '../lib/discoveryApi.js'

/**
 * The kind-specific body of one finding (E12).
 *
 * Six kinds share one table, and what differs between them is a `detail` payload. This is the
 * only place that knows the shape of each — everything upstream treats a finding as a label, a
 * location and an opaque payload.
 */
const str = (d: Record<string, unknown>, k: string): string => {
  const v = d[k]
  return typeof v === 'string' ? v : ''
}
const list = (d: Record<string, unknown>, k: string): string[] =>
  Array.isArray(d[k]) ? (d[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []

function Pair({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <span style={{ marginRight: 16 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}: </span>{value}
    </span>
  )
}

function EndpointDetail({ d }: { d: Record<string, unknown> }) {
  const auth = str(d, 'auth') || 'UNKNOWN'
  const tone = auth === 'NONE' ? 'var(--warn)'
    : auth === 'REQUIRED' ? 'var(--ok)' : 'var(--text-muted)'
  return (
    <div>
      <Pair label="Handler" value={str(d, 'handler')} />
      <span style={{ marginRight: 16 }}>
        <span style={{ color: 'var(--text-muted)' }}>Auth: </span>
        {/* UNKNOWN is shown as-is. Rendering it as "none" would invent a security finding;
            rendering it as "required" would hide one. */}
        <span style={{ color: tone, fontWeight: 600 }}>{auth}</span>
        {str(d, 'auth_mechanism') && ` (${str(d, 'auth_mechanism')})`}
      </span>
      <Pair label="Parameters" value={list(d, 'parameters').join(', ')} />
    </div>
  )
}

function EntityDetail({ d }: { d: Record<string, unknown> }) {
  const fields = Array.isArray(d['fields'])
    ? (d['fields'] as Array<Record<string, unknown>>) : []
  const relationships = list(d, 'relationships')
  return (
    <div>
      <Pair label="Store" value={str(d, 'store')} />
      {fields.length > 0 && (
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Key</th></tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={i}>
                <td>{String(f['name'] ?? '')}</td>
                <td style={{ color: 'var(--text-muted)' }}>{String(f['type'] ?? '')}</td>
                <td>
                  {f['key'] === 'NONE' ? '' : String(f['key'] ?? '')}
                  {f['references'] ? ` → ${String(f['references'])}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {relationships.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {relationships.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  )
}

function CapabilityDetail({ d }: { d: Record<string, unknown> }) {
  return (
    <div>
      <Pair label="Area" value={str(d, 'area')} />
      <span style={{ marginRight: 16 }}>
        <span style={{ color: 'var(--text-muted)' }}>Completeness: </span>
        {/* A factual observation about the code in front of us, not a rating. MINIMAL is shown
            plainly and without colour: it is not a criticism. */}
        <strong>{str(d, 'completeness')}</strong>
      </span>
      <Pair label="Key files" value={list(d, 'key_files').join(', ')} />
    </div>
  )
}

function SecurityDetail({ d }: { d: Record<string, unknown> }) {
  const concern = str(d, 'concern')
  const tone = concern === 'HIGH' ? 'var(--danger)'
    : concern === 'MEDIUM' ? 'var(--warn)' : 'var(--text-muted)'
  const benign = str(d, 'benign_explanation')
  return (
    <div>
      <span style={{ marginRight: 16 }}>
        {/* "Concern", never "severity": this system has no CVE database, cannot resolve
            dependency versions, and read only the files a budget allowed. */}
        <span style={{ color: 'var(--text-muted)' }}>Concern if confirmed: </span>
        <strong style={{ color: tone }}>{concern}</strong>
      </span>
      {benign && (
        <p style={{
          margin: '8px 0 0', padding: '8px 10px', borderRadius: 6,
          background: 'var(--bg)', border: '1px solid var(--border)',
        }}>
          <strong>Check this first: </strong>{benign}
        </p>
      )}
    </div>
  )
}

const BY_KIND: Record<string, (props: { d: Record<string, unknown> }) => JSX.Element> = {
  ENDPOINT: EndpointDetail,
  ENTITY: EntityDetail,
  CAPABILITY: CapabilityDetail,
  SECURITY: SecurityDetail,
  INTEGRATION: ({ d }) => (
    <div>
      <Pair label="Protocol" value={str(d, 'protocol')} />
      <Pair label="Direction" value={str(d, 'direction')} />
      <Pair label="Endpoint" value={str(d, 'endpoint_hint')} />
    </div>
  ),
  STACK: ({ d }) => (
    <div>
      <Pair label="Category" value={str(d, 'category')} />
      <Pair label="Version" value={str(d, 'version')} />
    </div>
  ),
}

export function FindingDetail({ finding }: { finding: Finding }) {
  const Detail = BY_KIND[finding.kind]
  return Detail ? <Detail d={finding.detail} /> : null
}
