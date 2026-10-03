/**
 * Standards compliance assessment (E06-S03).
 *
 * A standard is a switch, not a journey (acceptance 2): the organisation either requires
 * something and got it, or did not. The verdict vocabulary is therefore
 * COMPLIANT / PARTIAL / NON_COMPLIANT, with NOT_APPLICABLE for a standard that cannot sensibly
 * apply to the submission in front of it.
 *
 * NOT_APPLICABLE is a real answer, not an escape hatch. A dependency-pinning standard has
 * nothing to say about a repository with no dependency manifest, and scoring that
 * NON_COMPLIANT would mark a team down for the shape of their problem. E07-S01 excludes it
 * from the denominator in the same way it excludes an unscored criterion.
 */
import { buildContext, type EvidenceTarget } from '@crucible/scoring'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { callModel } from '../../llm/services/llmGateway.js'
import { citationGuard, citationOptions, withVerdicts } from './citationGuard.js'
import { discoveryDigestOrAbsent } from '../../discovery/services/discoveryDigest.js'
import { contextOptions, excerptSpans } from './criterionScorer.js'
import { standardSchema } from './scoreSchemas.js'
import {
  selectActiveStandards, upsertStandardAssessment, type StandardRow,
} from '../db/principlesDb.js'
import type { ScanResult } from '@crucible/scanner'

const log = createLogger('scoring', 'standardsEvaluator')

export type Compliance = 'COMPLIANT' | 'PARTIAL' | 'NON_COMPLIANT' | 'NOT_APPLICABLE'

export interface StandardOutcome {
  standardId: number
  code: string
  compliance: Compliance | null
  nonScore: 'INSUFFICIENT_EVIDENCE' | 'SCORING_FAILED' | 'NOT_APPLICABLE' | null
  confidence: number
  rationale: string
  evidence: Array<{
    path: string; lineStart: number; lineEnd: number; excerpt: string
    verdict: string; verdictReason: string
  }>
  costUsd: number
}

export function standardAsTarget(standard: StandardRow): EvidenceTarget {
  return {
    criterionId: `standard:${standard.standard_id}`,
    name: standard.name,
    description: standard.description,
    evidenceSpec: standard.evidence_spec,
  }
}

export interface AssessStandardsInput {
  runIndexId: number
  submissionId: number
  scan: ScanResult
  ledgerRunId?: number
}

export async function assessStandards(
  input: AssessStandardsInput,
): Promise<StandardOutcome[]> {
  const standards = await selectActiveStandards()

  if (standards.length === 0) {
    log.info('no standards are adopted, so none were assessed', {
      submissionId: input.submissionId,
    })
    return []
  }

  const outcomes: StandardOutcome[] = []
  const options = await contextOptions()

  for (const standard of standards) {
    const outcome = await assessOne(standard, input, options)
    await upsertStandardAssessment({
      runIndexId: input.runIndexId,
      submissionId: input.submissionId,
      standardId: outcome.standardId,
      compliance: outcome.compliance,
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
  standard: StandardRow,
  input: AssessStandardsInput,
  options: Awaited<ReturnType<typeof contextOptions>>,
): Promise<StandardOutcome> {
  const context = buildContext(standardAsTarget(standard), input.scan, options)
  const base = { standardId: standard.standard_id, code: standard.code, costUsd: 0 }

  if (context.insufficientEvidence) {
    return {
      ...base,
      compliance: null,
      nonScore: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      rationale: context.insufficientReason
        ?? `No evidence bearing on ${standard.name} could be located.`,
      evidence: [],
    }
  }

  try {
    const result = await callModel({
      callKey: 'scoring.standards',
      variables: {
        standard_code: standard.code,
        standard_name: standard.name,
        standard_description: standard.description,
        evidence_spec: standard.evidence_spec,
        repo_summary: context.repoSummary,
        // See principlesEvaluator: a map of what discovery found, additional to the excerpts.
        // A concern discovery could not extract arrives as NOT DETERMINED, so a standard is
        // never judged non-compliant because the extractor fell over (ADR 0003).
        discovery_context: await discoveryDigestOrAbsent(input.submissionId),
      },
      untrusted: excerptSpans(context),
      schema: standardSchema,
      // P4.1's third validation: a citation must exist in the commit we scanned.
      semantic: citationGuard(input.scan, await citationOptions(), {
        callKey: 'scoring.standards', subject: `standard:${standard.code}`,
      }),
      subject: { type: 'submission', id: String(input.submissionId) },
      ...(input.ledgerRunId !== undefined && { runId: input.ledgerRunId }),
    })

    const output = result.data
    if (output.insufficient_evidence) {
      return {
        ...base,
        compliance: null,
        nonScore: 'INSUFFICIENT_EVIDENCE',
        confidence: output.confidence,
        rationale: output.rationale,
        evidence: [],
        costUsd: result.costUsd,
      }
    }

    // NOT_APPLICABLE is recorded in BOTH columns: as the verdict, because it is what the
    // assessment concluded, and as the non-score, because E07-S01 must exclude it from the
    // denominator. The table's XOR constraint forbids that, so the verdict column wins and the
    // exclusion is derived from it downstream (see principlesDimension.standardsAsScores).
    return {
      ...base,
      compliance: output.compliance,
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
    log.error('standard assessment failed', {
      submissionId: input.submissionId, code: standard.code, err,
    })
    return {
      ...base,
      compliance: null,
      nonScore: 'SCORING_FAILED',
      confidence: 0,
      rationale: `Assessment could not be completed: ${errorMessage(err)}`,
      evidence: [],
    }
  }
}
