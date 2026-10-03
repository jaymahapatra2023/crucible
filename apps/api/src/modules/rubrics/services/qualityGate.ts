/**
 * Criterion quality gate (E02-S05).
 *
 * Rejects criteria that cannot be scored from a repository *before* a reviewer spends attention
 * on them, so review time goes on judgement rather than cleanup.
 *
 * Two rules matter more than the model's opinion, and both are enforced here rather than asked
 * for in the prompt:
 *
 *  - **A rejected criterion is regenerated once, then surfaced as `NEEDS_REWRITE` — never
 *    dropped** (acceptance 2). Silently discarding a criterion would quietly reshape the rubric
 *    the committee thinks it is reviewing.
 *  - **Every decision is recorded with its reasons and shown in review** (acceptance 4).
 */
import { z } from 'zod'
import type { GeneratedCriterion } from '@crucible/rubric'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { callModel } from '../../llm/services/llmGateway.js'

const log = createLogger('rubrics', 'qualityGate')

const anchorsSchema = z.object({
  0: z.string().min(1), 1: z.string().min(1), 2: z.string().min(1),
  3: z.string().min(1), 4: z.string().min(1),
})

const gateSchema = z.object({
  verdict: z.enum(['CHECKABLE', 'NEEDS_REWRITE', 'UNCHECKABLE']),
  reasons: z.array(z.string()).default([]),
  anchor_problems: z.array(z.object({
    levels: z.array(z.number()), why: z.string(),
  })).default([]),
  rewritten: z.object({
    name: z.string().min(3),
    description: z.string().min(1),
    evidence_spec: z.string().min(1),
    anchors: anchorsSchema,
  }).optional(),
})

export type GateVerdict = z.infer<typeof gateSchema>['verdict']

export interface GateOutcome {
  criterion: GeneratedCriterion
  verdict: GateVerdict
  /** True when the gate rewrote it and the rewrite passed (acceptance 2). */
  repaired: boolean
  /** True when the criterion must go to the reviewer marked NEEDS_REWRITE. */
  needsRewrite: boolean
  notes: string[]
}

/** Assess one criterion, repairing it once if the gate says it can be repaired. */
export async function gateCriterion(
  criterion: GeneratedCriterion,
  runId?: number,
): Promise<GateOutcome> {
  const first = await assess(criterion, runId)

  if (first.verdict === 'CHECKABLE') {
    return { criterion, verdict: 'CHECKABLE', repaired: false, needsRewrite: false, notes: noteOf(first) }
  }

  if (first.verdict === 'UNCHECKABLE') {
    // Not repairable by rewording. Surfaced, not dropped.
    return {
      criterion, verdict: 'UNCHECKABLE', repaired: false, needsRewrite: true,
      notes: noteOf(first),
    }
  }

  // NEEDS_REWRITE — regenerate exactly once (acceptance 2).
  if (!first.rewritten) {
    return {
      criterion, verdict: 'NEEDS_REWRITE', repaired: false, needsRewrite: true,
      notes: [...noteOf(first), 'The gate judged this rewritable but returned no rewrite.'],
    }
  }

  const rewritten: GeneratedCriterion = {
    ...criterion,
    name: first.rewritten.name,
    description: first.rewritten.description,
    evidenceSpec: first.rewritten.evidence_spec,
    anchors: first.rewritten.anchors,
  }

  const second = await assess(rewritten, runId)
  if (second.verdict === 'CHECKABLE') {
    log.info('criterion repaired by the gate', { name: criterion.name })
    return {
      criterion: rewritten, verdict: 'CHECKABLE', repaired: true, needsRewrite: false,
      notes: [`Rewritten by the quality gate. Original: "${criterion.name}".`, ...noteOf(first)],
    }
  }

  // Persistent failure: surfaced to the reviewer marked NEEDS_REWRITE, never dropped.
  log.warn('criterion failed the gate twice', { name: criterion.name, verdict: second.verdict })
  return {
    criterion: rewritten,
    verdict: second.verdict,
    repaired: false,
    needsRewrite: true,
    notes: [
      'Failed the quality gate twice; a reviewer must rewrite or remove it.',
      ...noteOf(first),
      ...noteOf(second),
    ],
  }
}

/**
 * Gate a whole set.
 *
 * A gate failure on one criterion does not fail the batch: the criterion is passed through
 * marked `NEEDS_REWRITE` with the error recorded. Losing the whole generated set because one
 * model call timed out would be a worse outcome than a reviewer seeing one flagged item.
 */
export async function gateCriteria(
  criteria: readonly GeneratedCriterion[],
  runId?: number,
): Promise<GateOutcome[]> {
  const outcomes: GateOutcome[] = []
  for (const criterion of criteria) {
    try {
      outcomes.push(await gateCriterion(criterion, runId))
    } catch (err) {
      log.error('quality gate call failed', { err, name: criterion.name })
      outcomes.push({
        criterion,
        verdict: 'NEEDS_REWRITE',
        repaired: false,
        needsRewrite: true,
        notes: [`The quality gate could not be run for this criterion: ${errorMessage(err)}`],
      })
    }
  }

  const flagged = outcomes.filter((o) => o.needsRewrite).length
  log.info('quality gate complete', { total: outcomes.length, flagged })
  return outcomes
}

async function assess(criterion: GeneratedCriterion, runId?: number) {
  const result = await callModel({
    callKey: 'rubrics.quality_gate',
    variables: {
      criterion_name: criterion.name,
      description: criterion.description,
      evidence_spec: criterion.evidenceSpec,
      anchor_0: criterion.anchors[0],
      anchor_1: criterion.anchors[1],
      anchor_2: criterion.anchors[2],
      anchor_3: criterion.anchors[3],
      anchor_4: criterion.anchors[4],
    },
    schema: gateSchema,
    ...(runId !== undefined && { runId }),
  })
  return result.data
}

function noteOf(result: z.infer<typeof gateSchema>): string[] {
  const notes = [...result.reasons]
  for (const problem of result.anchor_problems) {
    notes.push(`Anchors ${problem.levels.join(' and ')}: ${problem.why}`)
  }
  return notes
}
