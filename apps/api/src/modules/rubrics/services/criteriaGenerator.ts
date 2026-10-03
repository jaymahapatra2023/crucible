/**
 * Criteria generation (E02-S04) with the mandatory worker → reviewer → judge pattern (P4.3).
 *
 * Three properties are load-bearing and each is enforced structurally rather than by prompt:
 *
 *  - **Weights are not generated.** The output schema has no weight field, so the model cannot
 *    assign one even if it tries (finding F4, invariant 2).
 *  - **Re-running produces a new version.** This service never mutates an existing rubric
 *    (acceptance 5); versioning is the caller's contract and the freeze trigger enforces it.
 *  - **The reviewer is mandatory.** If the reviewer or judge call fails, generation fails. It
 *    does not silently degrade to a single unreviewed pass (P4.3).
 */
import { z } from 'zod'
import { generatedCriteriaSchema, type GeneratedCriterion } from '@crucible/rubric'
import { createLogger } from '../../../lib/logger.js'
import { AppError } from '../../../lib/appError.js'
import { callModel } from '../../llm/services/llmGateway.js'

const log = createLogger('rubrics', 'criteriaGenerator')

const reviewSchema = z.object({
  missing_coverage: z.array(z.object({ what: z.string(), brief_ref: z.string() })).default([]),
  not_checkable: z.array(z.object({ criterion_name: z.string(), why: z.string() })).default([]),
  overlapping: z.array(z.object({
    criterion_names: z.array(z.string()), why: z.string(),
  })).default([]),
  assessment: z.string().min(1),
})

const judgeSchema = z.object({
  verdict: z.enum(['PASS', 'PASS_WITH_NOTES', 'FAIL']),
  reasoning: z.string().min(1),
  must_address: z.array(z.string()).default([]),
})

export type CriteriaReview = z.infer<typeof reviewSchema>
export type CriteriaJudgement = z.infer<typeof judgeSchema>

export interface GenerationResult {
  criteria: GeneratedCriterion[]
  review: CriteriaReview
  judgement: CriteriaJudgement
  costUsd: number
  model: string
}

export interface GenerateInput {
  challengeName: string
  /** Assembled brief text. Untrusted only in the sense that it is uploaded content (P8.4). */
  briefText: string
  minCriteria: number
  maxCriteria: number
  runId?: number
}

/**
 * Propose criteria, review them independently, and judge the result.
 *
 * The brief is passed as an untrusted span. It is organiser-supplied rather than team-supplied,
 * so the risk is lower — but a brief can quote a team's proposal, and fencing costs nothing.
 */
export async function generateCriteria(input: GenerateInput): Promise<GenerationResult> {
  if (input.briefText.trim().length < 200) {
    // Risk R3: a thin brief cannot support checkable criteria. Enrich the brief; do not tune
    // the generator into inventing requirements the brief never stated.
    throw new AppError(
      'UNPROCESSABLE',
      `The extracted brief for '${input.challengeName}' is only ` +
        `${input.briefText.trim().length} characters. That is too thin to generate checkable ` +
        `criteria from. Upload a fuller brief rather than generating from what is there.`,
    )
  }

  const untrusted = [{ label: 'challenge brief', content: input.briefText }]

  // ── Worker ──────────────────────────────────────────────────────────────────────────────
  const worker = await callModel({
    callKey: 'rubrics.criteria_generate',
    variables: {
      challenge_name: input.challengeName,
      min_criteria: input.minCriteria,
      max_criteria: input.maxCriteria,
    },
    untrusted,
    schema: generatedCriteriaSchema,
    ...(input.runId !== undefined && { runId: input.runId }),
  })

  const criteria = worker.data.criteria
  log.info('criteria proposed', {
    callKey: 'rubrics.criteria_generate',
    challenge: input.challengeName, count: criteria.length,
  })

  // ── Reviewer (mandatory — P4.3) ─────────────────────────────────────────────────────────
  const reviewer = await callModel({
    callKey: 'rubrics.criteria_review',
    variables: { challenge_name: input.challengeName },
    untrusted: [
      ...untrusted,
      { label: 'proposed criteria', content: JSON.stringify(criteria, null, 2) },
    ],
    schema: reviewSchema,
    ...(input.runId !== undefined && { runId: input.runId }),
  })

  // ── Judge ───────────────────────────────────────────────────────────────────────────────
  const judge = await callModel({
    callKey: 'rubrics.criteria_judge',
    variables: { challenge_name: input.challengeName },
    untrusted: [
      { label: 'proposed criteria', content: JSON.stringify(criteria, null, 2) },
      { label: 'independent review', content: JSON.stringify(reviewer.data, null, 2) },
    ],
    schema: judgeSchema,
    ...(input.runId !== undefined && { runId: input.runId }),
  })

  if (judge.data.verdict === 'FAIL') {
    throw new AppError(
      'QUALITY_GATE_FAILED',
      `Generated criteria for '${input.challengeName}' were judged unfit to review: ` +
        `${judge.data.reasoning}`,
      { details: { mustAddress: judge.data.must_address, review: reviewer.data } },
    )
  }

  log.info('criteria generated', {
    challenge: input.challengeName,
    count: criteria.length,
    verdict: judge.data.verdict,
    costUsd: worker.costUsd + reviewer.costUsd + judge.costUsd,
  })

  return {
    criteria,
    review: reviewer.data,
    judgement: judge.data,
    costUsd: worker.costUsd + reviewer.costUsd + judge.costUsd,
    model: worker.model,
  }
}
