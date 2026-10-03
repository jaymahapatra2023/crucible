/**
 * One criterion's score, with the evidence behind it (E06-S02 acceptance 1).
 *
 * The rule this component exists to honour: a non-score is displayed as a non-score, never as a
 * zero and never as a blank. "Not enough evidence" and "scored 0" mean opposite things to a
 * reviewer, and a UI that renders both as an empty cell destroys the distinction the whole
 * scoring pipeline works to preserve (P5.1, P5.2).
 */
import type { CriterionScore, EvidenceItem } from '../lib/scoringApi.js'

const NON_SCORE_LABEL: Record<string, string> = {
  INSUFFICIENT_EVIDENCE: 'Not enough evidence to score',
  SCORING_FAILED: 'Scoring failed — not an assessment of the work',
  NOT_APPLICABLE: 'Does not apply to this submission',
}

const NON_SCORE_EXPLANATION: Record<string, string> = {
  INSUFFICIENT_EVIDENCE:
    'This is not a low score. Nothing in the files that were read let this criterion be judged, '
    + 'so it was excluded from the average rather than counted as zero.',
  SCORING_FAILED:
    'The scoring call could not be completed. This says nothing about the submission, and the '
    + 'criterion was excluded from the average rather than counted as zero.',
  NOT_APPLICABLE:
    'This criterion cannot sensibly apply here, so it was excluded from the average.',
}

export function ScoreCard({ score }: { score: CriterionScore }) {
  const unscored = score.raw_score === null

  return (
    <article
      style={{
        border: '1px solid var(--border)', borderRadius: 6,
        padding: 12, marginBottom: 12,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <ScoreBadge score={score.raw_score} nonScore={score.non_score} />
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {score.dimension.replace(/_/g, ' ').toLowerCase()}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12 }}>
          {unscored ? '' : `confidence ${score.confidence}%`}
        </span>
      </header>

      {unscored && score.non_score && (
        <p style={{ fontSize: 13, color: 'var(--warn)', margin: '8px 0' }}>
          {NON_SCORE_EXPLANATION[score.non_score]}
        </p>
      )}

      {score.anchor_matched && (
        <p style={{ fontSize: 13, margin: '8px 0' }}>
          <strong>Anchor matched:</strong> {score.anchor_matched}
        </p>
      )}

      <p style={{ fontSize: 13, margin: '8px 0' }}>{score.rationale}</p>

      <EvidenceList evidence={score.evidence} />

      <footer style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        Rubric v{score.rubric_version}
        {score.model ? ` · ${score.model}` : ''}
        {' · '}{score.files_searched} files searched
        {score.context_truncated && (
          // Never silent: a truncated context means the scorer may not have seen the best
          // evidence, which is exactly what an appeal would want to know (E04-S04 acceptance 3).
          <span style={{ color: 'var(--warn)' }}> · context budget truncated</span>
        )}
      </footer>
    </article>
  )
}

export function ScoreBadge({ score, nonScore }: { score: number | null; nonScore: string | null }) {
  if (score === null) {
    return (
      <strong style={{ color: 'var(--warn)', fontSize: 13 }}>
        {nonScore ? NON_SCORE_LABEL[nonScore] ?? nonScore : 'Not scored'}
      </strong>
    )
  }
  return <strong style={{ fontSize: 18 }}>{score}<span style={{ fontSize: 12, color: 'var(--text-muted)' }}> / 4</span></strong>
}

export function EvidenceList({ evidence }: { evidence: EvidenceItem[] }) {
  if (evidence.length === 0) return null
  return (
    <details>
      <summary style={{ fontSize: 12, cursor: 'pointer' }}>
        {evidence.length} piece{evidence.length === 1 ? '' : 's'} of evidence
      </summary>
      {evidence.map((item, index) => (
        <figure key={`${item.path}:${item.lineStart}:${index}`} style={{ margin: '8px 0' }}>
          <figcaption style={{
            fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)',
            display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline',
          }}>
            <span>{item.path}:{item.lineStart}–{item.lineEnd}</span>
            <CitationVerdict verdict={item.verdict} reason={item.verdictReason} />
          </figcaption>
          <pre style={{
            fontSize: 11, overflowX: 'auto', background: 'var(--surface-2)',
            padding: 8, borderRadius: 4, margin: '4px 0 0',
          }}>{item.excerpt}</pre>
        </figure>
      ))}
    </details>
  )
}

/**
 * Whether this quotation was found in the commit the team submitted (E13-S04).
 *
 * The distinction a reviewer needs in one glance: checked, or not checkable. `UNVERIFIABLE` is
 * worded as a statement about our reading — the file was outside the scan budget — never as
 * doubt about the team, because that is what it is.
 *
 * Never colour alone (P5.5): each state carries a word.
 */
function CitationVerdict({
  verdict, reason,
}: {
  verdict?: 'VERIFIED' | 'UNVERIFIABLE' | 'CONTRADICTED'
  reason?: string
}) {
  if (verdict === undefined) return null

  const tone = verdict === 'VERIFIED' ? 'var(--ok)'
    : verdict === 'UNVERIFIABLE' ? 'var(--text-muted)' : 'var(--danger)'
  const label = verdict === 'VERIFIED' ? 'checked against the source'
    : verdict === 'UNVERIFIABLE' ? 'outside what the scan read' : 'not found in the source'

  return (
    <span style={{ color: tone, fontFamily: 'var(--font)' }} title={reason}>
      {label}
    </span>
  )
}
