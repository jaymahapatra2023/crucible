/**
 * Architectural principle assessment (E06-S03).
 *
 * Acceptance 1 is the whole point of this file: principles are assessed from the SAME
 * code-bearing context the criterion scorer uses (E06-S01), not from a tech-stack list. The
 * upstream reference implementation assessed principle adoption from a declared stack and a
 * summary blob, which meant it was grading a description of the work rather than the work.
 *
 * Acceptance 2 keeps the 0–4 maturity model: adopting a principle is a journey, and collapsing
 * it to met/not-met would lose the distinction between a team who started and a team who did
 * not. Standards are the opposite shape and live in `standardsEvaluator.ts`.
 */
import { buildContext, type EvidenceTarget } from '@crucible/scoring'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { callModel } from '../../llm/services/llmGateway.js'
import { citationGuard, citationOptions, withVerdicts } from './citationGuard.js'
import { discoveryDigestOrAbsent } from '../../discovery/services/discoveryDigest.js'
import { contextOptions, excerptSpans } from './criterionScorer.js'
import { principleSchema } from './scoreSchemas.js'
import {
  selectActivePrinciples, upsertPrincipleAssessment, type PrincipleRow,
} from '../db/principlesDb.js'
import type { ScanResult } from '@crucible/scanner'

const log = createLogger('scoring', 'principlesEvaluator')

export interface PrincipleOutcome {
  principleId: number
  code: string
  maturity: number | null
  nonScore: 'INSUFFICIENT_EVIDENCE' | 'SCORING_FAILED' | 'NOT_APPLICABLE' | null
  confidence: number
  rationale: string
  evidence: Array<{
    path: string; lineStart: number; lineEnd: number; excerpt: string
    verdict: string; verdictReason: string
  }>
  costUsd: number
}

/** A principle, expressed as something the context builder can select evidence for. */
export function principleAsTarget(principle: PrincipleRow): EvidenceTarget {
  return {
    criterionId: `principle:${principle.principle_id}`,
    name: principle.name,
    description: principle.description,
    evidenceSpec: principle.evidence_spec,
  }
}

export interface AssessPrinciplesInput {
  runIndexId: number
  submissionId: number
  scan: ScanResult
  ledgerRunId?: number
}

/**
 * Assess every ADOPTED principle.
 *
 * A committee that has adopted none gets an empty result, which E07 reads as an unscoreable
 * dimension rather than as a dimension full of zeros (OD-2, acceptance 4).
 */
export async function assessPrinciples(
  input: AssessPrinciplesInput,
): Promise<PrincipleOutcome[]> {
  const principles = await selectActivePrinciples()

  if (principles.length === 0) {
    log.info('no principles are adopted, so none were assessed', {
      submissionId: input.submissionId,
    })
    return []
  }

  const outcomes: PrincipleOutcome[] = []
  const options = await contextOptions()

  for (const principle of principles) {
    const outcome = await assessOne(principle, input, options)
    await upsertPrincipleAssessment({
      runIndexId: input.runIndexId,
      submissionId: input.submissionId,
      principleId: outcome.principleId,
      maturity: outcome.maturity,
      nonScore: outcome.nonScore,
      confidence: outcome.confidence,
      rationale: outcome.rationale,
      evidence: outcome.evidence,
    })
    outcomes.push(outcome)
  }

  return outcomes
}

async function assessOne(
  principle: PrincipleRow,
  input: AssessPrinciplesInput,
  options: Awaited<ReturnType<typeof contextOptions>>,
): Promise<PrincipleOutcome> {
  const context = buildContext(principleAsTarget(principle), input.scan, options)
  const base = { principleId: principle.principle_id, code: principle.code, costUsd: 0 }

  if (context.insufficientEvidence) {
    return {
      ...base,
      maturity: null,
      nonScore: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      rationale: context.insufficientReason
        ?? `No evidence bearing on ${principle.name} could be located.`,
      evidence: [],
    }
  }

  try {
    const result = await callModel({
      callKey: 'scoring.principles',
      variables: {
        principle_code: principle.code,
        principle_name: principle.name,
        principle_description: principle.description,
        evidence_spec: principle.evidence_spec,
        // Verbatim, for the same reason the criterion scorer supplies its anchors verbatim:
        // a team is entitled to be judged by the wording that was adopted.
        anchor_0: principle.anchor_0,
        anchor_1: principle.anchor_1,
        anchor_2: principle.anchor_2,
        anchor_3: principle.anchor_3,
        anchor_4: principle.anchor_4,
        repo_summary: context.repoSummary,
        // What discovery extracted, as a map of where things are (ADR 0003). Additional to the
        // excerpts below, never instead of them: an assessment made from this alone would be a
        // second-order pass over a summary, which is the defect E06-S01 exists to fix.
        discovery_context: await discoveryDigestOrAbsent(input.submissionId),
      },
      untrusted: excerptSpans(context),
      schema: principleSchema,
      // P4.1's third validation: a citation must exist in the commit we scanned.
      semantic: citationGuard(input.scan, await citationOptions(), {
        callKey: 'scoring.principles', subject: `principle:${principle.code}`,
      }),
      subject: { type: 'submission', id: String(input.submissionId) },
      ...(input.ledgerRunId !== undefined && { runId: input.ledgerRunId }),
    })

    const output = result.data
    if (output.insufficient_evidence) {
      return {
        ...base,
        maturity: null,
        nonScore: 'INSUFFICIENT_EVIDENCE',
        confidence: output.confidence,
        rationale: output.rationale,
        evidence: [],
        costUsd: result.costUsd,
      }
    }

    return {
      ...base,
      maturity: output.maturity,
      nonScore: null,
      confidence: output.confidence,
      rationale: output.rationale,
      // The verdicts of checking each citation, stored with the assessment so a reviewer and
      // an appeal packet see the same thing months apart — and in the same shape a criterion
      // score uses, because a reader should not have to learn two evidence formats.
      evidence: withVerdicts(output.evidence, input.scan, await citationOptions()),
      costUsd: result.costUsd,
    }
  } catch (err) {
    // Never zero. A principle nobody could assess is unassessed (P3.5's stated exception).
    log.error('principle assessment failed', {
      submissionId: input.submissionId, code: principle.code, err,
    })
    return {
      ...base,
      maturity: null,
      nonScore: 'SCORING_FAILED',
      confidence: 0,
      rationale: `Assessment could not be completed: ${errorMessage(err)}`,
      evidence: [],
    }
  }
}
