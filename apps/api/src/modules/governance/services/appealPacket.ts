/**
 * The appeal packet (E09-S02).
 *
 * "An appeal is answered with a document rather than a database query." That sentence is the
 * specification. When a team writes in three months asking why they did not present, nobody
 * should have to reconstruct the answer by joining nine tables against a schema that has moved
 * on — and nobody should have to trust that the reconstruction matches what was true at the time.
 *
 * Three properties follow from it, and each is a constraint on this file:
 *
 *  1. **Self-contained.** Every figure the packet cites is carried inside it, including the
 *     rubric text the team was judged against and the excerpts each score was based on. A packet
 *     that says "criterion 14" and expects the reader to look it up is a database query wearing
 *     a document's clothes.
 *  2. **Readable without system access.** It renders as Markdown, not as a JSON dump, and every
 *     non-score is spelled out rather than left as a code.
 *  3. **Audited.** Generating one is itself recorded (acceptance 3): who asked what about whom
 *     is part of the governance record.
 */
import { selectScoreRun, selectScoresFor } from '../../scoring/db/scoringDb.js'
import { selectDimensionScores, selectRanking } from '../../scoring/db/rankingDb.js'
import { selectFlags } from '../../review/db/flagDb.js'
import { selectDecisions } from '../../review/db/shortlistDb.js'
import { probesFor, provenanceFor } from '../../review/db/sourceDb.js'
import { loadRubric } from '../../rubrics/services/rubricService.js'
import { query } from '../../../db/pool.js'
import { AppError } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { auditTrailFor } from './auditService.js'
import { discoveryDigest as discoveryDigest_ } from '../../discovery/services/discoveryDigest.js'
import { renderPacket } from './appealRender.js'

export interface PacketInput {
  runIndexId: number
  submissionId: number
  actor: string
}

export async function appealPacket(input: PacketInput): Promise<string> {
  const data = await gather(input)

  // Acceptance 3. Recorded before the document is handed over, so a packet cannot be produced
  // without the request for it appearing in the log.
  await recordAudit({
    actor: input.actor,
    action: 'governance.appeal_packet_generated',
    subjectType: 'submission',
    subjectId: String(input.submissionId),
    payload: {
      runIndexId: input.runIndexId,
      teamName: data.submission.team_name,
      rubricId: data.rubric.rubricId,
      rubricVersion: data.rubric.version,
      rankGlobal: data.ranking?.rank_global ?? null,
    },
  })

  return renderPacket(data)
}

export interface PacketData {
  generatedAt: string
  run: Awaited<ReturnType<typeof selectScoreRun>>
  submission: {
    submission_id: number; team_name: string; challenge_id: number
    repo_url: string; build_method: string; locked_commit_sha: string | null
    validation_status: string; submitted_at: Date
  }
  rubric: Awaited<ReturnType<typeof loadRubric>>
  ranking: Awaited<ReturnType<typeof selectRanking>>[number] | undefined
  dimensions: Awaited<ReturnType<typeof selectDimensionScores>>
  criteria: Awaited<ReturnType<typeof selectScoresFor>>
  flags: Awaited<ReturnType<typeof selectFlags>>
  decision: Awaited<ReturnType<typeof selectDecisions>>[number] | undefined
  probe: Awaited<ReturnType<typeof probesFor>> extends Map<number, infer V> ? V | undefined : never
  provenance: {
    flags: Array<{ code: string; message: string }>
    /** Whether a person looked at the flagged history, and what they concluded (E19-S03). */
    resolved: boolean
    resolutionReason: string | null
  }
  /**
   * What discovery told the principles and standards evaluators, where a pass informed this run.
   *
   * Empty when none did. Carrying it matters because a team disputing a principles score cannot
   * otherwise see the map the evaluator was given — and a packet that omits part of the basis
   * for the scores it reports is not the self-contained document it claims to be.
   */
  discoveryDigest: string
  auditTrail: Awaited<ReturnType<typeof auditTrailFor>>
}

async function gather(input: PacketInput): Promise<PacketData> {
  const run = await selectScoreRun(input.runIndexId)
  if (!run) {
    throw new AppError('NOT_FOUND', `Scoring run ${input.runIndexId} was not found.`)
  }

  const submission = await submissionRow(input.submissionId)
  if (!submission) {
    throw new AppError(
      'NOT_FOUND',
      `Submission ${input.submissionId} was not found. A superseded entry has no packet of its ` +
        `own — the packet belongs to the submission that was scored.`,
    )
  }

  const criteria = await selectScoresFor(input.runIndexId, input.submissionId)
  if (criteria.length === 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Submission ${input.submissionId} has no scores in run ${input.runIndexId}. There is ` +
        `nothing to appeal against, and a packet of empty sections would imply otherwise.`,
    )
  }

  // The rubric the SCORES cite, not whichever is current. A team is entitled to the standard
  // they were actually judged against, even after it has been re-versioned.
  const rubric = await loadRubric(criteria[0]!.rubric_id)

  const [ranking, dimensions, flags, decisions, probes, provenance, discoveryDigest, auditTrail] =
    await Promise.all([
      selectRanking(input.runIndexId),
      selectDimensionScores(input.runIndexId, input.submissionId),
      selectFlags(input.runIndexId, input.submissionId),
      selectDecisions(input.runIndexId),
      probesFor([input.submissionId]),
      provenanceFor([input.submissionId]),
      discoveryDigest_(input.submissionId),
      auditTrailFor('submission', String(input.submissionId)),
    ])

  return {
    generatedAt: new Date().toISOString(),
    run,
    submission,
    rubric,
    ranking: ranking.find((r) => r.submission_id === input.submissionId),
    dimensions,
    criteria,
    flags,
    decision: decisions.find((d) => d.submission_id === input.submissionId),
    probe: probes.get(input.submissionId),
    provenance: provenance.get(input.submissionId)
      ?? { flags: [], resolved: false, resolutionReason: null },
    discoveryDigest,
    auditTrail,
  }
}

async function submissionRow(submissionId: number): Promise<PacketData['submission'] | null> {
  const res = await query<PacketData['submission']>(
    `SELECT submission_id, team_name, challenge_id, repo_url, build_method,
            locked_commit_sha, validation_status, submitted_at
       FROM v_submissions_submission WHERE submission_id = $1`,
    [submissionId])
  return res.rows[0] ?? null
}
