/**
 * End-to-end rubric synthesis (E02-S04 + E02-S05).
 *
 * Generate → quality gate → persist as a NEW version, always. The committee then reviews and
 * weights it (E02-S06). Nothing here approves anything: finding F4's first invariant is that
 * generated criteria are never used unreviewed, so the output of this service is a DRAFT.
 */
import {
  DEFAULT_DIMENSION_WEIGHTS, rescaleToOne, validateRubric,
  type GeneratedCriterion, type ValidationIssue,
} from '@crucible/rubric'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { isEnabled } from '../../platform/services/configService.js'
import { assembleBriefText } from '../../challenges/services/extractionService.js'
import { generateCriteria, type CriteriaJudgement, type CriteriaReview } from './criteriaGenerator.js'
import { gateCriteria, type GateOutcome } from './qualityGate.js'
import { createVersion } from './rubricService.js'
import { selectLatestVersion } from '../db/rubricDb.js'
import type { CriterionInput } from '../db/rubricDb.js'
import type { Rubric } from '@crucible/rubric'

const log = createLogger('rubrics', 'synthesis')

const MIN_CRITERIA = 5
const MAX_CRITERIA = 10

export interface SynthesisResult {
  rubric: Rubric
  review: CriteriaReview
  judgement: CriteriaJudgement
  gate: {
    total: number
    checkable: number
    repaired: number
    needsRewrite: number
  }
  /**
   * Validation of the PERSISTED rubric, not merely of the model's output (E02-S04 acceptance 4).
   * A draft that cannot validate is a draft the committee would waste a session on.
   */
  validation: { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }
  /** Raised when the generator produced fewer or more criteria than the brief was asked for. */
  countAdvisory: string | null
  costUsd: number
}

export async function synthesiseRubric(input: {
  challengeId: number
  challengeName: string
  actor: string
  runId?: number
}): Promise<SynthesisResult> {
  if (!(await isEnabled('feature.rubrics.criteria_generation'))) {
    throw new AppError(
      'FORBIDDEN',
      'Criteria generation is disabled. Author the rubric by hand, or enable ' +
        'feature.rubrics.criteria_generation.',
    )
  }

  const brief = await assembleBriefText(input.challengeId)
  if (brief.sourceCount === 0) {
    throw new AppError(
      'UNPROCESSABLE',
      `No brief text has been extracted for this challenge. Upload a brief and confirm it ` +
        `extracted before generating criteria — generating from nothing produces criteria ` +
        `grounded in nothing.`,
    )
  }

  const generated = await generateCriteria({
    challengeName: input.challengeName,
    briefText: brief.text,
    minCriteria: MIN_CRITERIA,
    maxCriteria: MAX_CRITERIA,
    ...(input.runId !== undefined && { runId: input.runId }),
  })

  const gateOutcomes = (await isEnabled('feature.rubrics.quality_gate'))
    ? await gateCriteria(generated.criteria, input.runId)
    : generated.criteria.map((criterion): GateOutcome => ({
        criterion, verdict: 'CHECKABLE', repaired: false, needsRewrite: false,
        notes: ['Quality gate disabled for this run.'],
      }))

  const rubric = await createVersion({
    challengeId: input.challengeId,
    criteria: toCriterionInputs(gateOutcomes),
    dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS },
    actor: input.actor,
    supersedes: null,
  })

  // E02-S04 acceptance 1 asks for 5–10 criteria. Returning fewer is the *correct* response to a
  // thin brief — the prompt says so explicitly — so this is surfaced as an advisory for the
  // committee rather than enforced as an error that would push the generator into padding.
  const count = gateOutcomes.length
  const countAdvisory = count < MIN_CRITERIA
    ? `The generator produced ${count} criteria, fewer than the ${MIN_CRITERIA} asked for. ` +
      `That usually means the brief does not state enough checkable requirements. Enrich the ` +
      `brief rather than accepting thin criteria.`
    : count > MAX_CRITERIA
      ? `The generator produced ${count} criteria, more than the ${MAX_CRITERIA} asked for. ` +
        `Review for overlap before weighting.`
      : null

  if (countAdvisory) log.warn('criteria count outside the requested range', { count, countAdvisory })

  const validation = validateRubric(rubric)
  if (!validation.valid) {
    log.error('generated rubric does not validate', {
      rubricId: rubric.rubricId,
      errors: validation.errors.map((e) => e.message),
    })
  }

  const summary = {
    total: gateOutcomes.length,
    checkable: gateOutcomes.filter((o) => !o.needsRewrite).length,
    repaired: gateOutcomes.filter((o) => o.repaired).length,
    needsRewrite: gateOutcomes.filter((o) => o.needsRewrite).length,
  }

  // The gate's decisions are logged with reasons and visible in review (E02-S05 acceptance 4).
  await recordAudit({
    actor: input.actor,
    action: 'rubric.quality_gate_run',
    subjectType: 'rubric',
    subjectId: rubric.rubricId,
    payload: {
      ...summary,
      decisions: gateOutcomes.map((o) => ({
        name: o.criterion.name, verdict: o.verdict, repaired: o.repaired, notes: o.notes,
      })),
    },
  })

  log.info('rubric synthesised', {
    challengeId: input.challengeId, rubricId: rubric.rubricId,
    version: rubric.version, ...summary, costUsd: generated.costUsd,
  })

  return {
    rubric,
    review: generated.review,
    judgement: generated.judgement,
    gate: summary,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    countAdvisory,
    costUsd: generated.costUsd,
  }
}

/**
 * Turn gate outcomes into rows.
 *
 * Weights are spread evenly across the fidelity criteria as a *starting point only* — the
 * rubric is DRAFT and E02-S06 blocks approval until a human has set them. An even split is
 * honest about being arbitrary; a model-chosen split would look considered and would not be.
 */
function toCriterionInputs(outcomes: readonly GateOutcome[]): CriterionInput[] {
  const weights = rescaleToOne(outcomes.map(() => 1))

  return outcomes.map((outcome, i) => {
    const c: GeneratedCriterion = outcome.criterion
    return {
      dimension: 'CHALLENGE_FIDELITY' as const,
      name: c.name,
      description: c.description,
      weight: weights[i] ?? 0,
      evidenceSpec: c.evidenceSpec,
      anchors: c.anchors,
      sourceRef: c.sourceRef,
      sortOrder: i,
      needsRewrite: outcome.needsRewrite,
      gateNotes: outcome.notes,
    }
  })
}

/** Next version number, for showing "this will create v3" before the work is spent. */
export async function nextVersionFor(challengeId: number): Promise<number> {
  return (await selectLatestVersion(challengeId)) + 1
}
