/**
 * The advisory originality signal (E06-S05, re-anchored in E35).
 *
 * **What this measures changed.** It was built to answer "how much of this is the team's own
 * work rather than generator output" — a question about PROVENANCE. The judging criteria ask
 * whether the solution "employs an innovative or creative approach", which is a question about
 * INVENTIVENESS. A dimension measuring one construct while its raters judge the other produces
 * no relationship between them, and calibration found exactly that: ρ 0.006, against 0.708 for
 * engineering quality over the same eleven repositories.
 *
 * The measurements did not go away; they changed job. Boilerplate share, template detection and
 * provenance now BOUND the judgement rather than being it — a submission with no substantive
 * code cannot demonstrate an inventive approach — and beyond that bound they say nothing about
 * whether an approach is any good.
 *
 * Three properties the story insists on, and each is load-bearing:
 *
 *  1. It considers boilerplate share, template detection and provenance — measured facts, not
 *     an impression (acceptance 1). The measurements live in `@crucible/scoring` and are pure.
 *  2. It is ADVISORY and carries the lowest weight (acceptance 2).
 *  3. It is never the sole reason a submission falls below the cut — enforced by E07-S06's
 *     `advisoryDecided`, which re-ranks the cohort with the dimension removed and reports when
 *     the outcome changes (acceptance 3).
 *
 * The dimension can be turned off. When it is, no row is written and E07 reads the ABSENCE as
 * "not scored", dropping it from the denominator. A disabled dimension that scored zero would
 * penalise every team for a setting an operator changed.
 */
import {
  buildContext, describeOriginality, originalitySignals, type OriginalitySignals,
} from '@crucible/scoring'
import { flagProvenance, type ScanResult } from '@crucible/scanner'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { getNumber, isEnabled } from '../../platform/services/configService.js'
import { callModel } from '../../llm/services/llmGateway.js'
import { citationGuard, citationOptions } from './citationGuard.js'
import { contextOptions, excerptSpans } from './criterionScorer.js'
import { originalitySchema } from './scoreSchemas.js'
import { upsertOriginality } from '../db/originalityDb.js'

const log = createLogger('scoring', 'originalityScorer')

export interface OriginalityOutcome {
  submissionId: number
  level: number | null
  nonScore: 'INSUFFICIENT_EVIDENCE' | 'SCORING_FAILED' | 'NOT_APPLICABLE' | null
  confidence: number
  rationale: string
  observations: string[]
  signals: OriginalitySignals
  provenanceFlags: Array<{ code: string; message: string }>
  costUsd: number
}

/**
 * The whole repository is the evidence target here, not one criterion's worth of it.
 *
 * The evidence specification drives file selection through the one context builder, so it has to
 * describe where an APPROACH is visible — the parts of a codebase where a team made a choice —
 * rather than where authorship is visible. Selecting files to prove who wrote them would hand
 * the model the wrong evidence for the question it is now being asked.
 */
const ORIGINALITY_TARGET = {
  criterionId: 'originality',
  name: 'Inventiveness of the approach',
  description:
    'Whether this submission solves the problem in a way that shows a considered point of view, ' +
    'rather than taking the default path.',
  evidenceSpec:
    'The parts of the codebase where an approach is visible: how the core problem is modelled, ' +
    'the algorithm or data structure at the heart of it, how components are composed, and any ' +
    'mechanism the team built rather than imported. Not formatting, naming or documentation.',
}

export interface ScoreOriginalityInput {
  runIndexId: number
  submissionId: number
  scan: ScanResult
  ledgerRunId?: number
}

/**
 * Returns null when the dimension is switched off — the caller records nothing, and E07 treats
 * the missing row as an unscored dimension rather than as a zero.
 */
export async function scoreOriginality(
  input: ScoreOriginalityInput,
): Promise<OriginalityOutcome | null> {
  if (!(await isEnabled('feature.scoring.originality'))) {
    log.info('originality is disabled; the dimension is omitted rather than scored', {
      submissionId: input.submissionId,
    })
    return null
  }

  const signals = originalitySignals(input.scan)
  const provenanceFlags = flagProvenance(signals.provenance, {
    maxOutOfWindowPct: await getNumber('scans.provenance_max_out_of_window_pct'),
    maxSingleCommitPct: await getNumber('scans.provenance_max_single_commit_pct'),
  })

  const outcome = await judge(input, signals, provenanceFlags)

  await upsertOriginality({
    runIndexId: input.runIndexId,
    submissionId: input.submissionId,
    level: outcome.level,
    nonScore: outcome.nonScore,
    confidence: outcome.confidence,
    rationale: outcome.rationale,
    observations: outcome.observations,
    evidence: outcome.evidence,
    boilerplateSharePct: signals.boilerplate.sharePct,
    scaffoldLines: signals.boilerplate.scaffoldLines,
    substantiveLines: signals.boilerplate.substantiveLines,
    templates: signals.templates,
    provenanceFlags,
    model: outcome.model,
    costUsd: outcome.costUsd,
  })

  return { ...outcome, submissionId: input.submissionId, signals, provenanceFlags }
}

interface Judgement {
  level: number | null
  nonScore: OriginalityOutcome['nonScore']
  confidence: number
  rationale: string
  observations: string[]
  evidence: Array<{ path: string; lineStart: number; lineEnd: number; excerpt: string }>
  model: string | null
  costUsd: number
}

async function judge(
  input: ScoreOriginalityInput,
  signals: OriginalitySignals,
  provenanceFlags: Array<{ code: string; message: string }>,
): Promise<Judgement> {
  const context = buildContext(ORIGINALITY_TARGET, input.scan, await contextOptions())

  // A repository with no substantive lines needs no model call. This is the bound the
  // measurements impose: there is no approach to judge, because there is no code implementing
  // one. Asking a model to rate the inventiveness of an empty scaffold invites it to invent an
  // answer from the framework's own choices.
  if (signals.boilerplate.substantiveLines === 0 && !signals.partialScan) {
    return {
      level: 0,
      nonScore: null,
      confidence: 90,
      rationale:
        `Every one of the ${signals.boilerplate.totalLines} analysed lines sits in a generated ` +
        `or configuration file. There is no code of the team's own implementing an approach, ` +
        `so there is no approach to assess.`,
      observations: signals.templates.map((t) => `Generated by ${t.name} (${t.matchedOn}).`),
      evidence: [],
      model: null,
      costUsd: 0,
    }
  }

  const summary = [describeOriginality(signals), ...provenanceFlags.map((f) => f.message)]
    .join('\n')

  try {
    const result = await callModel({
      callKey: 'scoring.originality',
      variables: { repo_summary: context.repoSummary, signals_summary: summary },
      untrusted: excerptSpans(context),
      schema: originalitySchema,
      // P4.1's third validation. Advisory or not, a citation must be real: this dimension is
      // the one most likely to be disputed, so its evidence is the least affordable to invent.
      semantic: citationGuard(input.scan, await citationOptions(), {
        callKey: 'scoring.originality', subject: `submission:${input.submissionId}`,
      }),
      subject: { type: 'submission', id: String(input.submissionId) },
      ...(input.ledgerRunId !== undefined && { runId: input.ledgerRunId }),
    })

    const output = result.data
    return {
      level: output.insufficient_evidence ? null : output.level,
      nonScore: output.insufficient_evidence ? 'INSUFFICIENT_EVIDENCE' : null,
      confidence: output.confidence,
      rationale: output.rationale,
      observations: output.observations,
      evidence: output.insufficient_evidence ? [] : output.evidence.map((e) => ({
        path: e.path, lineStart: e.line_start, lineEnd: e.line_end, excerpt: e.excerpt,
      })),
      model: result.model,
      costUsd: result.costUsd,
    }
  } catch (err) {
    log.error('originality assessment failed', { submissionId: input.submissionId, err })
    return {
      level: null,
      nonScore: 'SCORING_FAILED',
      confidence: 0,
      rationale: `The advisory inventiveness signal could not be produced: ${errorMessage(err)}`,
      observations: [],
      evidence: [],
      model: null,
      costUsd: 0,
    }
  }
}
