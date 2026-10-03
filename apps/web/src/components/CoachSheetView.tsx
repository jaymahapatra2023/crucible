import type { CoachSheet } from '../lib/coachApi.js'

/**
 * One coach sheet (E51), readable on a phone in a corridor and printable one to a page.
 *
 * The coach's copy carries findings and questions, never a rank or a decision; `showStanding`
 * is the organiser's view. Every question says why it is asked — the finding it came from — so
 * a coach is never fishing.
 */
export function CoachSheetView({ sheet, showStanding }: { sheet: CoachSheet; showStanding: boolean }) {
  return (
    <article className="sheet" data-testid={`sheet-${sheet.submissionId}`} style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 20,
      background: 'var(--surface)', maxWidth: 720,
    }}>
      <header>
        <h2 style={{ fontSize: 17, margin: 0 }}>{sheet.teamName}</h2>
        <p style={{ margin: '4px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          {sheet.challenge}
          {sheet.room && <> · {sheet.room}</>}
          {sheet.coach && <> · coach {sheet.coach}</>}
        </p>
        {sheet.members.length > 0 && <p style={{ margin: '2px 0', fontSize: 13 }}>Team: {sheet.members.join(', ')}</p>}
        <p style={{ margin: '2px 0', fontSize: 12, wordBreak: 'break-all' }}>
          <a href={sheet.repoUrl} target="_blank" rel="noreferrer">{sheet.repoUrl}</a>
          {sheet.commit && <code style={{ marginLeft: 6 }}>@ {sheet.commit.slice(0, 10)}</code>}
        </p>
        {showStanding && (
          <p style={{ margin: '4px 0', fontSize: 13 }} data-testid="standing">
            <strong>Standing (organiser only):</strong> rank {sheet.standing.rankInRun ?? '—'} in run
            {' · '}final {sheet.standing.finalRank ?? '—'} · {sheet.standing.decision ?? 'no decision'}
          </p>
        )}
      </header>

      <Built b={sheet.built} />

      <h3 style={H3}>Did it run</h3>
      <p style={{ margin: 0, fontSize: 13 }}>
        {sheet.ran ? <><strong>{sheet.ran.outcome}</strong> — {sheet.ran.reason}</> : <span style={MUTED}>Not probed.</span>}
      </p>

      {sheet.strengths.length > 0 && (
        <>
          <h3 style={H3}>Open with</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {sheet.strengths.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </>
      )}

      <Questions qs={sheet.questions} />

      <p style={{ marginTop: 12, fontSize: 12, color: 'var(--warn)' }}>{sheet.confidential}</p>
    </article>
  )
}

function Built({ b }: { b: CoachSheet['built'] }) {
  return (
    <>
      <h3 style={H3}>What they built</h3>
      {b.absent ? (
        <p style={MUTED}>No description was produced for this entry.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {b.stack.length > 0 && <li>Stack: {b.stack.join(', ')}</li>}
          {b.capabilities.length > 0 && <li>Does: {b.capabilities.join('; ')}</li>}
          <li>{b.endpoints} API endpoint{b.endpoints === 1 ? '' : 's'}
            {b.integrations.length > 0 && <> · integrates {b.integrations.join(', ')}</>}</li>
          {b.runtime && <li>Runtime: {b.runtime}</li>}
        </ul>
      )}
    </>
  )
}

function Questions({ qs }: { qs: CoachSheet['questions'] }) {
  return (
    <>
      <h3 style={H3}>Questions to ask</h3>
      {qs.length === 0 ? (
        <p style={MUTED}>Nothing the evaluation flagged. Ask what they would do with another day.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {qs.map((q, i) => (
            <li key={i} style={{ marginBottom: 10 }}>
              <p style={{ margin: 0, fontWeight: 600 }}>{q.ask}</p>
              <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                Because: {q.because}
                {q.evidence && <> — <code>{q.evidence}</code></>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

const H3: React.CSSProperties = { fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', margin: '14px 0 4px' }
const MUTED: React.CSSProperties = { margin: 0, fontSize: 13, color: 'var(--text-muted)' }
