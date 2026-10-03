/**
 * Raising and dismissing review flags (E08-S03).
 *
 * Flags are generated as part of ranking, so the set a reviewer sees is the set that existed
 * when the ranking they are looking at was produced. Generating them on read would mean the
 * caveats shown alongside a decision could differ from the caveats that informed it, and the
 * record would not say which.
 *
 * The wording lives in `@crucible/scoring/reviewFlags` beside the conditions that raise it. This
 * file gathers the evidence and writes the result down.
 */
import { buildReviewFlags } from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { getNumber } from '../../platform/services/configService.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import {
  dismissFlagRow, replaceFlags, selectFlags, type FlagInsert, type FlagRow,
} from '../db/flagDb.js'
import {
  nonScoresFor, probesFor, provenanceFor, scanCoverageFor, varianceFor,
} from '../db/sourceDb.js'

const log = createLogger('review', 'flagService')

export interface FlagSubject {
  submissionId: number
  normalisationMethod: string
  cohortSize: number
  advisoryDecided: boolean
  /** Normalised challenge fidelity, as it entered the composite. */
  challengeFidelity?: number | null
  /** Mean of the other dimensions that were scored, for the contrast the flag draws. */
  otherDimensionsMean?: number | null
}

/**
 * Regenerate every flag for a run.
 *
 * Called from the ranking operation, which already knows the cohort and the advisory outcome.
 */
export async function generateFlags(input: {
  runIndexId: number
  cohortKey: string
  minCohortSize: number
  subjects: readonly FlagSubject[]
}): Promise<number> {
  const submissionIds = input.subjects.map((s) => s.submissionId)

  const [coverage, probes, provenance, nonScores, variance] = await Promise.all([
    scanCoverageFor(submissionIds),
    probesFor(submissionIds),
    provenanceFor(submissionIds),
    nonScoresFor(input.runIndexId),
    varianceFor(input.cohortKey),
  ])

  const flags: FlagInsert[] = []

  for (const subject of input.subjects) {
    const id = subject.submissionId
    const scan = coverage.get(id)
    const probe = probes.get(id)

    const built = buildReviewFlags({
      scan: scan && {
        filesAnalysed: scan.files_analyzed,
        filesTotal: scan.files_total,
        budgetTruncated: scan.budget_truncated,
      },
      nonScores: nonScores.get(id),
      probe: probe && {
        outcome: probe.outcome, runsGrade: probe.runs_grade, reason: probe.grade_reason,
      },
      // Flag generation cares only about what was observed, not about whether a person has
      // since looked at it — a resolution is a governance record, not an input to a caveat.
      provenance: provenance.get(id)?.flags,
      normalisation: {
        method: subject.normalisationMethod,
        cohortSize: subject.cohortSize,
        floor: input.minCohortSize,
      },
      variance: variance.get(id),
      advisoryDecided: subject.advisoryDecided,
      fidelity: subject.challengeFidelity === undefined ? undefined : {
        score: subject.challengeFidelity,
        otherDimensionsMean: subject.otherDimensionsMean ?? null,
        threshold: await getNumber('scoring.low_fidelity_threshold'),
      },
    })

    for (const flag of built) flags.push({ submissionId: id, ...flag })
  }

  await replaceFlags(input.runIndexId, flags)
  log.info('review flags generated', { runIndexId: input.runIndexId, flags: flags.length })
  return flags.length
}

export async function listFlags(
  runIndexId: number, submissionId?: number,
): Promise<FlagRow[]> {
  return selectFlags(runIndexId, submissionId)
}

/**
 * Dismiss one flag, with a reason (acceptance 3).
 *
 * The length rule is enforced by the database. What this adds is the audit row: a caveat set
 * aside is part of how the outcome was reached, and "who decided this did not matter, and why"
 * is exactly what an appeal asks.
 */
export async function dismissFlag(input: {
  runIndexId: number
  submissionId: number
  code: string
  actor: string
  reason: string
}): Promise<FlagRow> {
  let row: FlagRow | null
  try {
    row = await dismissFlagRow(input)
  } catch (err) {
    if (String(err).includes('chk_flag_dismissal_has_reason')) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Dismissing a flag requires a reason of at least ten characters. The flag records ' +
          'something the system could not resolve on its own; setting it aside without saying ' +
          'why leaves an appeal with nothing to answer.',
      )
    }
    throw err
  }

  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `No '${input.code}' flag for submission ${input.submissionId} in run ${input.runIndexId}.`,
    )
  }

  await recordAudit({
    actor: input.actor,
    action: 'review.flag_dismissed',
    subjectType: 'submission',
    subjectId: String(input.submissionId),
    payload: {
      runIndexId: input.runIndexId,
      code: input.code,
      reason: input.reason,
      message: row.message,
    },
  })

  return row
}
