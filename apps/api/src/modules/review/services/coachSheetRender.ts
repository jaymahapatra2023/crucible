/**
 * A coach sheet as plain text, for email (E51). The organiser's copy may carry the standing;
 * the coach's never does. One page: five questions at most, one line each plus its reason.
 */
import type { CoachSheet } from './coachSheet.js'

export function renderSheetText(s: CoachSheet, opts: { forCoach: boolean }): string {
  return [
    ...headerLines(s, opts.forCoach), '',
    'WHAT THEY BUILT', ...builtLines(s.built), '',
    'DID IT RUN', `  ${s.ran ? `${s.ran.outcome} — ${s.ran.reason}` : 'Not probed.'}`,
    ...(s.strengths.length ? ['', 'OPEN WITH', ...s.strengths.map((st) => `  + ${st}`)] : []),
    '', 'QUESTIONS TO ASK', ...questionLines(s), '', s.confidential,
  ].join('\n')
}

function headerLines(s: CoachSheet, forCoach: boolean): string[] {
  const lines = [`${s.teamName} — ${s.challenge}`]
  if (s.members.length > 0) lines.push(`Team: ${s.members.join(', ')}`)
  lines.push(`Where: ${s.room ?? 'no room recorded'}${s.coach ? ` · coach ${s.coach}` : ''}`)
  lines.push(`Repository: ${s.repoUrl}${s.commit ? ` @ ${s.commit.slice(0, 10)}` : ''}`)
  if (!forCoach) {
    lines.push(`Standing: rank ${s.standing.rankInRun ?? '—'} in run · final ${s.standing.finalRank ?? '—'} · ${s.standing.decision ?? 'no decision'}`)
  }
  return lines
}

function builtLines(b: CoachSheet['built']): string[] {
  if (b.absent) return ['  (no description was produced for this entry)']
  const lines: string[] = []
  if (b.stack.length) lines.push(`  Stack: ${b.stack.join(', ')}`)
  if (b.capabilities.length) lines.push(`  Does: ${b.capabilities.join('; ')}`)
  lines.push(`  ${b.endpoints} API endpoint${b.endpoints === 1 ? '' : 's'}`
    + (b.integrations.length ? ` · integrates ${b.integrations.join(', ')}` : ''))
  if (b.runtime) lines.push(`  Runtime: ${b.runtime}`)
  return lines
}

function questionLines(s: CoachSheet): string[] {
  if (s.questions.length === 0) return ['  Nothing the evaluation flagged. Ask what they would do with another day.']
  return s.questions.flatMap((q, i) => [
    `  ${i + 1}. ${q.ask}`, `     Because: ${q.because}`, ...(q.evidence ? [`     See: ${q.evidence}`] : []),
  ])
}
