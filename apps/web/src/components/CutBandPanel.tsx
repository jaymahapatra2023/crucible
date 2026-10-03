/**
 * The cut-line band (E07-S06).
 *
 * Every submission here requires review (acceptance 2) — the heading says so rather than leaving
 * it as a convention somebody has to know. The advisory call-out (acceptance 3) is separated out
 * because it is a different claim: not "this one is close", but "this one's position turns on the
 * dimension we told you not to trust on its own".
 */
import { Link } from 'react-router-dom'
import type { CutBandReport } from '../lib/scoringApi.js'

export function CutBandPanel({ report, runId }: { report: CutBandReport; runId: number }) {
  if (report.band.length === 0) {
    return (
      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>At the cut line</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No submission falls within {report.bandSize} places of rank {report.cutLine}.
        </p>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>
        At the cut line — {report.band.length} require review
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        Within {report.bandSize} places of rank {report.cutLine}. Being listed here is not a
        judgement — it is where a person’s attention changes the outcome.
      </p>

      {report.advisoryDecided.length > 0 && (
        <p
          role="status"
          data-testid="advisory-decided"
          style={{
            fontSize: 13, color: 'var(--warn)', border: '1px solid var(--warn)',
            borderRadius: 6, padding: 10, margin: '0 0 10px',
          }}
        >
          {report.advisoryDecided.length === 1 ? 'One submission’s' : `${report.advisoryDecided.length} submissions’`}
          {' '}position depends on the advisory inventiveness dimension: removing it would move
          {report.advisoryDecided.length === 1 ? ' it ' : ' them '}
          across the cut line. Inventiveness is the least reliable dimension and must not decide
          this on its own — check the other evidence before accepting the placement.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Submission</th>
            <th scope="col">Challenge</th>
            <th scope="col">Composite</th>
            <th scope="col">Evidence</th>
            <th scope="col">Why it needs a look</th>
          </tr>
        </thead>
        <tbody>
          {report.band.map((row) => (
            <tr key={row.submission_id}>
              <td>{row.rank_global}</td>
              <td>
                <Link to={`/scoring/runs/${runId}/submissions/${row.submission_id}`}>
                  {row.team_name ?? row.submission_id}
                </Link>
              </td>
              <td>{row.challenge_id}</td>
              <td>{Number(row.composite).toFixed(1)}</td>
              <td>{Math.round(Number(row.weight_covered) * 100)}%</td>
              <td>
                {row.review_reason_text.length > 0
                  ? row.review_reason_text.join('; ')
                  : 'close to the line'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
