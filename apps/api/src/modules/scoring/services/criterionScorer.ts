/**
 * Scoring one criterion against real source (E06-S02, E06-S04).
 *
 * The rules that matter most are about what happens when things go wrong:
 *
 *  - A criterion whose evidence cannot be located is `INSUFFICIENT_EVIDENCE`, never 0.
 *  - A criterion whose scoring call fails is `SCORING_FAILED`, never 0 (acceptance 3).
 *  - Every score records the rubric id, version and hash it ran under (acceptance 4).
 *
 * Both non-scores are excluded from the denominator by E07-S01 rather than dragging an average
 * down. Defaulting either to zero would mark a team down for something nobody checked.
 */
import { buildContext, type ScoringContext } from '@crucible/scoring'
import type { Criterion, Rubric } from '@crucible/rubric'
import type { ScanResult } from '@crucible/scanner'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { getNumber } from '../../platform/services/configService.js'
import { callModel } from '../../llm/services/llmGateway.js'
import { criterionScoreSchema, type CriterionScoreOutput } from './scoreSchemas.js'
import { citationGuard, citationOptions, withVerdicts } from './citationGuard.js'

const log = createLogger('scoring', 'criterionScorer')

export interface ScoredCriterion {
  criterionId: number
  dimension: Criterion['dimension']
  rawScore: number | null
  nonScore: 'INSUFFICIENT_EVIDENCE' | 'SCORING_FAILED' | 'NOT_APPLICABLE' | null
  confidence: number
  rationale: string
  anchorMatched: string | null
  evidence: Array<{
    path: string; lineStart: number; lineEnd: number; excerpt: string
    /** Whether the cited location was found in the scan (E13, P4.1 clause 3). */
    verdict: string; verdictReason: string
  }>
  contextBytes: number
  contextTruncated: boolean
  filesSearched: number
  model: string | null
  attempts: number
  costUsd: number
  /** Set when the code tried to address the model (P8.4 clause 4). */
  injectionNoted: string | null
}

export async function contextOptions() {
  return {
    budgetBytes: await getNumber('scoring.context_budget_bytes'),
    windowLines: await getNumber('scoring.context_window_lines'),
    maxFiles: await getNumber('scoring.context_max_files'),
    minRelevance: await getNumber('scoring.context_min_relevance'),
  }
}

export interface ScoreCriterionInput {
  criterion: Criterion
  rubric: Rubric
  scan: ScanResult
  /** Attributes this call's spend to the submission, including failed attempts (E10-S03). */
  submissionId?: number
  /** Extra facts for the ENGINEERING_QUALITY dimension (E06-S04 acceptance 1). */
  metricsSummary?: string
  runId?: number
}

export async function scoreCriterion(input: ScoreCriterionInput): Promise<ScoredCriterion> {
  const { criterion, scan } = input
  const context = buildContext(criterion, scan, await contextOptions())
  const citations = await citationOptions()

  const base = {
    criterionId: Number(criterion.criterionId),
    dimension: criterion.dimension,
    contextBytes: context.budgetUsedBytes,
    contextTruncated: context.budgetTruncated,
    filesSearched: context.filesSearched,
  }

  // The evidence could not be located. An honest non-score, not a low score (E06-S01 #4).
  if (context.insufficientEvidence) {
    log.info('criterion has insufficient evidence', {
      criterionId: criterion.criterionId, name: criterion.name,
    })
    return {
      ...base,
      rawScore: null,
      nonScore: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      rationale: context.insufficientReason ?? 'No evidence could be located for this criterion.',
      anchorMatched: null,
      evidence: [],
      model: null,
      attempts: 0,
      costUsd: 0,
      injectionNoted: null,
    }
  }

  // Engineering quality is judged from metrics AND source (E06-S04); every other dimension from
  // source alone. One call key per shape, so each has its own prompt, config and metrics.
  const callKey = criterion.dimension === 'ENGINEERING_QUALITY'
    ? 'scoring.engineering'
    : 'scoring.criterion'

  try {
    const result = await callModel({
      callKey,
      variables: {
        criterion_name: criterion.name,
        criterion_description: criterion.description,
        evidence_spec: criterion.evidenceSpec,
        // Supplied verbatim (acceptance 2): paraphrasing would judge teams by wording the
        // committee never approved.
        anchor_0: criterion.anchors[0],
        anchor_1: criterion.anchors[1],
        anchor_2: criterion.anchors[2],
        anchor_3: criterion.anchors[3],
        anchor_4: criterion.anchors[4],
        repo_summary: context.repoSummary,
        ...(callKey === 'scoring.engineering' && {
          metrics_summary: input.metricsSummary ?? 'No metrics were available.',
        }),
      },
      // The team's own code: fenced, labelled and scanned (P8.4).
      untrusted: excerptSpans(context),
      schema: criterionScoreSchema,
      // P4.1's third validation: the citations must exist in the commit we scanned.
      semantic: citationGuard(scan, citations, {
        callKey, subject: `criterion:${criterion.criterionId}`,
      }),
      ...(input.runId !== undefined && { runId: input.runId }),
      ...(input.submissionId !== undefined && {
        subject: { type: 'submission', id: String(input.submissionId) },
      }),
    })

    return {
      ...base,
      ...interpret({
        output: result.data, model: result.model, attempts: result.attempts,
        costUsd: result.costUsd, scan, citations,
      }),
    }
  } catch (err) {
    // The call failed after every attempt. Recorded as SCORING_FAILED — never as zero
    // (acceptance 3).
    log.error('criterion scoring failed', {
      criterionId: criterion.criterionId, name: criterion.name, err,
    })
    return {
      ...base,
      rawScore: null,
      nonScore: 'SCORING_FAILED',
      confidence: 0,
      rationale: `Scoring could not be completed: ${errorMessage(err)}`,
      anchorMatched: null,
      evidence: [],
      model: null,
      attempts: 0,
      costUsd: 0,
      injectionNoted: null,
    }
  }
}

interface Interpreted {
  output: CriterionScoreOutput
  model: string
  attempts: number
  costUsd: number
  scan: ScanResult
  citations: { drift: number }
}

function interpret({ output, model, attempts, costUsd, scan, citations }: Interpreted) {
  if (output.insufficient_evidence) {
    return {
      rawScore: null,
      nonScore: 'INSUFFICIENT_EVIDENCE' as const,
      confidence: output.confidence,
      rationale: output.rationale,
      anchorMatched: null,
      evidence: [],
      model, attempts, costUsd,
      injectionNoted: output.injection_noted,
    }
  }

  return {
    rawScore: output.score,
    nonScore: null,
    confidence: output.confidence,
    rationale: output.rationale,
    anchorMatched: output.anchor_matched,
    // Re-checked here rather than carried out of the guard: the guard runs per ATTEMPT and
    // reports only whether to reject, while these verdicts are stored against the score that
    // survived.
    evidence: withVerdicts(output.evidence, scan, citations),
    model, attempts, costUsd,
    injectionNoted: output.injection_noted,
  }
}

/** Each excerpt as its own labelled, fenced span, so the model can cite a location precisely. */
export function excerptSpans(context: ScoringContext): Array<{ label: string; content: string }> {
  return context.excerpts.map((e) => ({
    label: `${e.path}:${e.lineStart}-${e.lineEnd}`,
    content: e.text,
  }))
}
