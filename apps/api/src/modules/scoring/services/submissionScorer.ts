/**
 * Scoring one submission against a frozen rubric (E06).
 *
 * Reads the persisted scan (E04-S05 acceptance 2 — never triggers one), scores every criterion,
 * and records each result with the rubric version it ran under.
 *
 * Refuses to start against a rubric that is not FROZEN (E02-S07 acceptance 5). That guard is the
 * reason `assertScoreable` exists, and this is its first caller.
 */
import { assertScoreable, type Criterion, type Rubric } from '@crucible/rubric'
import { hashRubric } from '@crucible/rubric'
import type { ScanResult } from '@crucible/scanner'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { persistedScan } from '../../scans/services/scanService.js'
import { runsDimensionInput } from '../../probes/services/probeService.js'
import { scoreCriterion, type ScoredCriterion } from './criterionScorer.js'
import { assessPrinciples } from './principlesEvaluator.js'
import { assessStandards } from './standardsEvaluator.js'
import { scoreOriginality } from './originalityScorer.js'
import { selectScoredCriterionIds, upsertCriterionScore } from '../db/scoringDb.js'

const log = createLogger('scoring', 'submissionScorer')

export interface ScoreSubmissionInput {
  runIndexId: number
  submissionId: number
  rubric: Rubric
  /** Skip criteria already scored in this run (E10-S04 acceptance 2). */
  resume?: boolean
  ledgerRunId?: number
}

export interface SubmissionScoreSummary {
  submissionId: number
  scored: number
  insufficient: number
  failed: number
  skipped: number
  costUsd: number
  /** Raised when the team's own code tried to address the model (P8.4 clause 4). */
  injectionSuspected: boolean
  /** Adopted principles and standards assessed (E06-S03). Zero when none are adopted. */
  principlesAssessed: number
  standardsAssessed: number
  /** False when the advisory dimension is switched off, so the caller can say so (E06-S05). */
  originalityAssessed: boolean
}

export async function scoreSubmission(
  input: ScoreSubmissionInput,
): Promise<SubmissionScoreSummary> {
  // Scoring refuses to start against a rubric that is not FROZEN.
  assertScoreable(input.rubric)

  const scan = await persistedScan(input.submissionId)
  const rubricHash = input.rubric.contentHash
    ?? hashRubric(input.rubric.criteria, input.rubric.dimensionWeights)

  const alreadyScored = input.resume
    ? await selectScoredCriterionIds(input.runIndexId, input.submissionId)
    : new Set<number>()

  const summary: SubmissionScoreSummary = {
    submissionId: input.submissionId,
    scored: 0, insufficient: 0, failed: 0, skipped: 0, costUsd: 0,
    injectionSuspected: false,
    principlesAssessed: 0, standardsAssessed: 0, originalityAssessed: false,
  }

  const metricsSummary = describeMetrics(scan)

  for (const criterion of input.rubric.criteria) {
    if (alreadyScored.has(Number(criterion.criterionId))) {
      summary.skipped++
      continue
    }

    // The Runs dimension is objective and never model-scored (E05-S04 acceptance 3).
    const scored = criterion.dimension === 'RUNS'
      ? await scoreRunsFromProbe(criterion, input.submissionId)
      : await scoreCriterion({
          criterion,
          rubric: input.rubric,
          scan,
          metricsSummary,
          submissionId: input.submissionId,
          ...(input.ledgerRunId !== undefined && { runId: input.ledgerRunId }),
        })

    const { replaced } = await upsertCriterionScore({
      runIndexId: input.runIndexId,
      submissionId: input.submissionId,
      rubricId: Number(input.rubric.rubricId),
      rubricVersion: input.rubric.version,
      rubricHash,
      scored,
    })

    if (replaced) {
      // The score row itself has no history — it is overwritten in place — so the displaced
      // value is preserved here or nowhere (E09-S01 acceptance 1, "score written").
      await recordAudit({
        actor: 'system',
        action: 'scoring.score_replaced',
        subjectType: 'submission',
        subjectId: String(input.submissionId),
        payload: {
          runIndexId: input.runIndexId,
          criterionId: criterion.criterionId,
          from: { rawScore: replaced.raw_score, nonScore: replaced.non_score,
                  model: replaced.model, scoredAt: replaced.scored_at },
          to: { rawScore: scored.rawScore, nonScore: scored.nonScore, model: scored.model },
        },
      })
    }

    if (scored.rawScore !== null) summary.scored++
    else if (scored.nonScore === 'INSUFFICIENT_EVIDENCE') summary.insufficient++
    else if (scored.nonScore === 'SCORING_FAILED') summary.failed++
    summary.costUsd += scored.costUsd

    if (scored.injectionNoted) {
      summary.injectionSuspected = true
      // Surfaced for human review; never silently stripped and scored anyway (P8.4 clause 4).
      await recordAudit({
        actor: 'system',
        action: 'scoring.prompt_injection_suspected',
        subjectType: 'submission',
        subjectId: String(input.submissionId),
        payload: { criterionId: criterion.criterionId, noted: scored.injectionNoted },
      })
      log.warn('the submission’s own code addressed the model', {
        submissionId: input.submissionId, criterionId: criterion.criterionId,
      })
    }
  }

  // The three dimensions that are not rubric criteria (E06-S03, E06-S05). Each runs against the
  // same scan and the same context builder; each records its own rows and never a zero.
  const evaluatorInput = {
    runIndexId: input.runIndexId,
    submissionId: input.submissionId,
    scan,
    ...(input.ledgerRunId !== undefined && { ledgerRunId: input.ledgerRunId }),
  }

  const principles = await assessPrinciples(evaluatorInput)
  summary.principlesAssessed = principles.length
  summary.costUsd += principles.reduce((total, p) => total + p.costUsd, 0)

  const standards = await assessStandards(evaluatorInput)
  summary.standardsAssessed = standards.length
  summary.costUsd += standards.reduce((total, s) => total + s.costUsd, 0)

  const originality = await scoreOriginality(evaluatorInput)
  summary.originalityAssessed = originality !== null
  summary.costUsd += originality?.costUsd ?? 0

  // One row per submission scored, so "when was this team scored, against which rubric, and
  // how much of it could be judged" is answerable without reading the score table.
  await recordAudit({
    actor: 'system',
    action: 'scoring.submission_scored',
    subjectType: 'submission',
    subjectId: String(input.submissionId),
    payload: {
      runIndexId: input.runIndexId,
      rubricId: input.rubric.rubricId,
      rubricVersion: input.rubric.version,
      rubricHash,
      ...summary,
    },
  })

  log.info('submission scored', { ...summary })
  return summary
}

/**
 * The Runs dimension, taken from the build probe.
 *
 * No model call participates. The "evidence" is the probe's own record — which is exactly what a
 * reviewer would want to point at.
 */
async function scoreRunsFromProbe(
  criterion: Criterion, submissionId: number,
): Promise<ScoredCriterion> {
  const probe = await runsDimensionInput(submissionId)

  const base = {
    criterionId: Number(criterion.criterionId),
    dimension: criterion.dimension,
    contextBytes: 0, contextTruncated: false, filesSearched: 0,
    model: null, attempts: 0, costUsd: 0, injectionNoted: null,
    anchorMatched: null as string | null,
  }

  if (!probe) {
    // Unprobed is unmeasured, not failing.
    return {
      ...base,
      rawScore: null,
      nonScore: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      rationale: 'This submission has not been probed, so whether it builds is unknown.',
      evidence: [],
    }
  }

  if (probe.score < 0) {
    // UNSUPPORTED: a harness limitation, excluded from the denominator rather than scored 0.
    return {
      ...base,
      rawScore: null,
      nonScore: 'NOT_APPLICABLE',
      confidence: 100,
      rationale: probe.reason,
      evidence: [],
    }
  }

  return {
    ...base,
    rawScore: probe.score,
    nonScore: null,
    confidence: 100,
    rationale: probe.reason,
    anchorMatched: criterion.anchors[probe.score as 0 | 1 | 2 | 3 | 4] ?? null,
    // Verified by construction, and deliberately not checked against the scan. No model
    // produced this: the probe observed it by building and running the submission, and the
    // probe record IS the primary source. Pointing a scan-based verifier at a synthetic path
    // would report UNVERIFIABLE and imply a doubt that does not exist.
    evidence: [{
      path: `build_probe/${probe.probeId}`,
      lineStart: 1,
      lineEnd: 1,
      excerpt: probe.reason,
      verdict: 'VERIFIED',
      verdictReason: `Observed by build probe ${probe.probeId}; no model produced this.`,
    }],
  }
}

/** Measurements shown alongside the engineering-quality score (E06-S04 acceptance 3). */
export function describeMetrics(scan: ScanResult): string {
  const m = scan.metrics
  return [
    `${m.filesAnalysed} files analysed (${scan.filesTotal} present` +
      `${scan.budgetTruncated ? ', budget truncated' : ''}).`,
    `${m.totalLines} lines: ${m.codeLines} code, ${m.commentLines} comment, ${m.blankLines} blank.`,
    `Longest file ${m.maxFileLines} lines; ${m.longFiles.length} files over 400 lines.`,
    `Average file ${m.averageFileLines} lines.`,
    `Tests: ${m.hasTests ? `${m.testFileCount} files` : 'none'}.`,
    `CI: ${m.hasCi ? 'configured' : 'none'}. Dockerfile: ${m.hasDockerfile ? 'present' : 'none'}.`,
    `Lockfile: ${m.hasLockfile ? 'present' : 'none'}. Dependencies declared: ${m.dependencyCount}.`,
    `Languages: ${m.languages.join(', ') || 'none detected'}.`,
  ].join(' ')
}
