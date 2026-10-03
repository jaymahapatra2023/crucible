/**
 * A coach sheet per shortlisted team (E51): what the evaluation found, and what to ask.
 *
 * Composed entirely from evidence already on record — the team's scores and their cited
 * evidence, discovery's description of what was built and the claims it could not confirm,
 * the probe, provenance, originality, the two runs' disagreements — through the same reads the
 * team review page uses. Nothing here scores anything, and the sheet carries no number a coach
 * could read aloud: the *findings* and the questions they raise (`coachQuestions`).
 *
 * Sent by email only: coaches are staff, reached the way the roster holds them, and a sheet is
 * long. Each dispatch is recorded per coach so "did the coaches get them" is answerable.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { redactString } from '../../../lib/redact.js'
import { teamDetail } from './teamDetail.js'
import { coachQuestions, coachStrengths, type CoachQuestion, type SheetFacts } from './coachQuestions.js'
import { renderSheetText } from './coachSheetRender.js'
import { renderMail } from '../../submissions/services/mailTemplates.js'
import { discoveryView } from '../../discovery/services/discoveryView.js'
import { selectScoreRun } from '../../scoring/db/scoringDb.js'
import { selectRanking, selectSnapshot } from '../../scoring/db/rankingDb.js'
import { selectFinalRanking } from '../../scoring/db/finalRankingDb.js'
import {
  selectActivePrinciples, selectActiveStandards, selectPrincipleAssessments, selectStandardAssessments,
} from '../../scoring/db/principlesDb.js'
import { selectOriginality } from '../../scoring/db/originalityDb.js'
import { selectDecisions } from '../db/shortlistDb.js'
import {
  challengeName, coachesFor, criterionNames, insertDispatch, latestDispatches, membersFor,
  type CoachAssignment, type DispatchRow,
} from '../db/coachDb.js'

const log = createLogger('review', 'coachSheet')

export interface CoachSheet {
  submissionId: number
  teamId: number | null
  teamName: string
  challenge: string
  members: string[]
  room: string | null
  coach: string | null
  repoUrl: string
  commit: string | null
  /** Standing is for the ORGANISER's copy; the coach's rendering omits it. */
  standing: { rankInRun: number | null; finalRank: number | null; decision: string | null }
  built: { stack: string[]; capabilities: string[]; endpoints: number; integrations: string[]; runtime: string | null; absent: boolean }
  ran: { outcome: string; reason: string } | null
  strengths: string[]
  questions: CoachQuestion[]
  confidential: string
}

const CONFIDENTIAL = 'Scores, ranks and decisions are confidential until results are announced. Use this sheet to ask, not to tell.'

export async function coachSheet(runIndexId: number, submissionId: number): Promise<CoachSheet> {
  const run = await selectScoreRun(runIndexId)
  if (!run) throw new AppError('NOT_FOUND', `Scoring run ${runIndexId} was not found.`)
  const detail = await teamDetail(runIndexId, submissionId)
  if (!detail.submission) throw new AppError('NOT_FOUND', `Submission ${submissionId} was not found.`)

  const [names, discovery, principles, standards, principleRows, standardRows, originality, finalRows] =
    await Promise.all([
      criterionNames(detail.criteria.map((c) => c.criterion_id)),
      discoveryView(submissionId).catch(() => null),
      selectActivePrinciples(), selectActiveStandards(),
      selectPrincipleAssessments(runIndexId, submissionId), selectStandardAssessments(runIndexId, submissionId),
      selectOriginality(runIndexId, submissionId), selectFinalRanking(run.cohort_key),
    ])

  const { scored, facts } = assembleFacts({ detail, names, discovery, principles, standards, principleRows, standardRows, originality })

  const who = await describeTeam(detail.submission)
  const finalRow = finalRows.find((r) => r.submission_id === submissionId)

  return {
    submissionId, ...who,
    repoUrl: detail.submission.repo_url, commit: detail.submission.locked_commit_sha,
    standing: {
      rankInRun: detail.ranking?.rank_global ?? null, finalRank: finalRow?.rank_global ?? null,
      decision: detail.decision?.decision ?? null,
    },
    built: summariseBuilt(discovery),
    ran: detail.probe ? { outcome: detail.probe.outcome, reason: detail.probe.grade_reason } : null,
    strengths: coachStrengths([...scored].reverse()),
    questions: coachQuestions(facts),
    confidential: CONFIDENTIAL,
  }
}

/** Who the team is and where to find them, from the roster's published views. */
async function describeTeam(sub: NonNullable<Detail['submission']>) {
  const teamId = sub.team_id
  const [members, coaches, challenge] = await Promise.all([
    teamId === null ? Promise.resolve([]) : membersFor(teamId),
    teamId === null ? Promise.resolve(new Map<number, CoachAssignment>()) : coachesFor([teamId]),
    challengeName(sub.challenge_id),
  ])
  const place = teamId === null ? undefined : coaches.get(teamId)
  return {
    teamId, teamName: sub.team_name, challenge,
    members: members.map((m) => m.fullName + (m.isContact ? ' (contact)' : '')),
    room: place?.roomLabel ?? null, coach: place?.coachName ?? null,
  }
}

type Detail = Awaited<ReturnType<typeof teamDetail>>
type Discovery = Awaited<ReturnType<typeof discoveryView>> | null
interface FactInputs {
  detail: Detail
  names: Map<number, { name: string; dimension: string }>
  discovery: Discovery
  principles: Array<{ principle_id: number; name: string }>
  standards: Array<{ standard_id: number; name: string }>
  principleRows: Array<{ principle_id: number; maturity: number | null; rationale: string }>
  standardRows: Array<{ standard_id: number; compliance: string | null; rationale: string }>
  originality: Awaited<ReturnType<typeof selectOriginality>>
}

/** Everything the question rules look at, from what the run recorded. Scores stay here. */
function assembleFacts(i: FactInputs) {
  const { detail, names, discovery } = i
  const scored = detail.criteria
    .filter((c) => c.raw_score !== null)
    .map((c) => ({
      name: names.get(c.criterion_id)?.name ?? `criterion ${c.criterion_id}`,
      dimension: c.dimension, rawScore: c.raw_score as number, rationale: c.rationale,
      evidence: c.evidence[0] ? `${c.evidence[0].path}:${c.evidence[0].lineStart}` : null,
    }))
    .sort((a, b) => a.rawScore - b.rawScore)

  const principleName = new Map(i.principles.map((p) => [p.principle_id, p.name]))
  const standardName = new Map(i.standards.map((s) => [s.standard_id, s.name]))
  const lowest = i.principleRows.filter((p) => p.maturity !== null).sort((a, b) => (a.maturity ?? 0) - (b.maturity ?? 0))[0]

  const facts: SheetFacts = {
    probe: detail.probe ? { outcome: detail.probe.outcome, gradeReason: detail.probe.grade_reason } : null,
    conflicts: (discovery?.conflicts ?? []).map((c) => {
      const x = c as { claim: string; claim_path: string; observed: string }
      return { claim: x.claim, claimPath: x.claim_path, observed: x.observed }
    }),
    weakest: scored.slice(0, 3),
    originality: i.originality ? {
      boilerplatePct: Number(i.originality.boilerplate_share_pct), substantiveLines: i.originality.substantive_lines,
      templates: i.originality.templates.map((t) => t.name),
    } : null,
    provenanceFlags: detail.provenance,
    disagreements: detail.runDifferences.map((d) => ({
      criterion: names.get(d.criterionId)?.name ?? d.dimension,
      runA: describe(d.runA), runB: describe(d.runB),
    })),
    security: ((discovery?.findings['security'] ?? []) as Array<{ label: string; summary: string; path: string | null }>)
      .map((s) => ({ label: s.label, summary: s.summary, path: s.path })),
    lowestPrinciple: lowest ? { name: principleName.get(lowest.principle_id) ?? 'a principle', rationale: lowest.rationale } : null,
    nonCompliant: i.standardRows.filter((s) => s.compliance === 'NON_COMPLIANT')
      .map((s) => ({ name: standardName.get(s.standard_id) ?? 'a standard', rationale: s.rationale })),
  }
  return { scored, facts }
}

const describe = (r: { rawScore: number | null; nonScore: string | null }): string =>
  r.rawScore !== null ? `scored it ${r.rawScore} of 4` : `could not score it (${r.nonScore ?? 'no reason recorded'})`

function summariseBuilt(d: Awaited<ReturnType<typeof discoveryView>> | null): CoachSheet['built'] {
  if (!d || d.status !== 'COMPLETED') {
    return { stack: [], capabilities: [], endpoints: 0, integrations: [], runtime: null, absent: true }
  }
  const labels = (key: string, n: number) =>
    ((d.findings[key] ?? []) as Array<{ label: string }>).slice(0, n).map((f) => f.label)
  return {
    stack: labels('stack', 4), capabilities: labels('capabilities', 3),
    endpoints: (d.findings['endpoints'] ?? []).length, integrations: labels('integrations', 3),
    runtime: d.runtime ? `${d.runtime.containerised ? 'containerised' : 'not containerised'}; starts with ${d.runtime.entrypoint}` : null,
    absent: false,
  }
}

export type SheetScope = 'shortlist' | 'cutline'

/** The shortlisted submissions of a run, or — before any decision — those inside the cut line. */
export async function coachSheets(runIndexId: number, scope: SheetScope): Promise<CoachSheet[]> {
  const ids = await sheetSubjects(runIndexId, scope)
  const sheets: CoachSheet[] = []
  for (const id of ids) sheets.push(await coachSheet(runIndexId, id))
  return sheets
}

async function sheetSubjects(runIndexId: number, scope: SheetScope): Promise<number[]> {
  const ranking = await selectRanking(runIndexId)
  if (scope === 'shortlist') {
    const decisions = await selectDecisions(runIndexId)
    const chosen = new Set(decisions.filter((d) => d.decision === 'SHORTLIST').map((d) => d.submission_id))
    return ranking.filter((r) => chosen.has(r.submission_id)).map((r) => r.submission_id)
  }
  const snapshot = await selectSnapshot(runIndexId)
  const cut = snapshot?.cut_line_used ?? 0
  return ranking.filter((r) => r.rank_global <= cut).map((r) => r.submission_id)
}

export interface DispatchOutcome {
  sent: DispatchRow[]
  /** Teams in scope that have no coach on the roster: nobody to send to. Named, not skipped. */
  uncoached: string[]
}

export async function sendCoachSheets(input: { runIndexId: number; scope: SheetScope; actor: string }): Promise<DispatchOutcome> {
  const sheets = await coachSheets(input.runIndexId, input.scope)
  if (sheets.length === 0) {
    throw new AppError('PRECONDITION_FAILED',
      input.scope === 'shortlist' ? 'Nothing is shortlisted yet, so there is nothing to send.' : 'Nobody is inside the cut line of this ranking.')
  }
  const { byCoach, uncoached } = await groupByCoach(sheets)
  const provider = mail()
  const sent: DispatchRow[] = []
  for (const [coachId, group] of byCoach) {
    sent.push(await sendToCoach({ ...input, coachId, group, provider }))
  }

  await recordAudit({
    actor: input.actor, action: 'review.coach_sheets_sent', subjectType: 'run', subjectId: String(input.runIndexId),
    payload: { scope: input.scope, coaches: sent.map((s) => s.coachId), teams: sheets.map((s) => s.teamId), uncoached: uncoached.length },
  })
  return { sent, uncoached }
}

async function groupByCoach(sheets: CoachSheet[]) {
  const coaches = await coachesFor(sheets.map((s) => s.teamId).filter((t): t is number => t !== null))
  const byCoach = new Map<number, { coach: CoachAssignment; sheets: CoachSheet[] }>()
  const uncoached: string[] = []
  for (const sheet of sheets) {
    const c = sheet.teamId === null ? undefined : coaches.get(sheet.teamId)
    if (!c || c.coachId === null || !c.coachEmail) { uncoached.push(sheet.teamName); continue }
    const entry = byCoach.get(c.coachId) ?? { coach: c, sheets: [] }
    entry.sheets.push(sheet)
    byCoach.set(c.coachId, entry)
  }
  return { byCoach, uncoached }
}

async function sendToCoach(a: {
  runIndexId: number; actor: string; coachId: number
  group: { coach: CoachAssignment; sheets: CoachSheet[] }; provider: ReturnType<typeof mail>
}): Promise<DispatchRow> {
  const { coach, sheets: mine } = a.group
  const base = {
    runIndexId: a.runIndexId, coachId: a.coachId, teamIds: mine.map((s) => s.teamId as number),
    provider: a.provider.name, sentBy: a.actor,
  }
  try {
    // The coach's copy carries findings and questions — never a rank or a decision.
    const rendered = await renderMail('mail.coach_sheet', {
      coach_name: coach.coachName ?? 'coach', count: String(mine.length), plural: mine.length === 1 ? '' : 's',
      sheets: mine.map((s) => renderSheetText(s, { forCoach: true })).join('\n\n' + '='.repeat(72) + '\n\n'),
    })
    const result = await a.provider.send({
      to: coach.coachEmail as string, subject: rendered.subject, body: rendered.body,
      idempotencyKey: `coach-sheet/${a.runIndexId}/${a.coachId}/${Date.now()}`,
    })
    return insertDispatch({ ...base, status: result.delivered ? 'SENT' : 'PREPARED',
      detail: result.delivered ? null : result.detail, providerRef: result.providerRef ?? null })
  } catch (err) {
    const detail = redactString(err instanceof Error ? err.message : 'The message could not be sent.')
    log.warn('coach sheets could not be sent', { coachId: a.coachId, detail })
    return insertDispatch({ ...base, status: 'FAILED', detail, providerRef: null })
  }
}

export async function dispatchState(runIndexId: number): Promise<DispatchRow[]> {
  return [...(await latestDispatches(runIndexId)).values()]
}
