/**
 * The holistic evaluator: one call, the whole repository, no criteria.
 *
 * Built to answer a committee question with evidence rather than argument — if the scoring
 * criteria have not been validated, is an undecomposed model judgement better? This is that
 * approach, implemented faithfully: the brief, every file the scan read, and a single overall
 * score. No criterion, no anchor, no per-dimension breakdown.
 *
 * It runs through the same gateway as every other call, so it is logged, costed, retried and
 * schema-validated identically. What it must never do is reach a decision about a team: the
 * result lands in `holistic_evaluation` and nothing reads that table into a composite.
 */
import { z } from 'zod'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { getNumber } from '../../platform/services/configService.js'
import { callModel } from '../../llm/services/llmGateway.js'
import { selectLatestScan, selectRawResult } from '../../scans/db/scanDb.js'
import { selectBrief, selectSetSubjects, upsertHolistic, type HolisticRow } from '../db/holisticDb.js'

const log = createLogger('calibration', 'holistic')

export const holisticSchema = z.object({
  overall: z.number().int().min(0).max(100).nullable(),
  non_score: z.enum(['INSUFFICIENT_CONTEXT']).nullable().default(null),
  verdict: z.string().max(1000).default(''),
  reasoning: z.string().max(8000).default(''),
  strengths: z.array(z.string().max(600)).max(20).default([]),
  weaknesses: z.array(z.string().max(600)).max(20).default([]),
  evidence: z.array(z.object({
    path: z.string().max(500), why: z.string().max(600).default(''),
  })).max(30).default([]),
  confidence: z.number().int().min(0).max(100).nullable().default(null),
  injection_noted: z.string().max(4000).nullable().default(null),
})

/**
 * Every file the scan read, in full, up to a bounded budget.
 *
 * Ordered largest-first would spend the budget on a lockfile, so the order the scanner chose is
 * kept — it reads most informative first. Truncation is recorded rather than hidden, because a
 * comparison that quietly sent half of one repository and all of another would prove nothing.
 */
export function wholeRepoSpans(
  files: ReadonlyArray<{ path: string; content: string; truncated: boolean }>,
  options: { budgetBytes: number; maxFiles: number },
): { spans: Array<{ label: string; content: string }>; bytes: number; truncated: boolean } {
  const spans: Array<{ label: string; content: string }> = []
  let bytes = 0
  let truncated = false

  for (const file of files.slice(0, options.maxFiles)) {
    const cost = file.content.length
    if (bytes + cost > options.budgetBytes) {
      truncated = true
      continue
    }
    spans.push({
      label: file.path + (file.truncated ? ' (cut short by the scan)' : ''),
      content: file.content,
    })
    bytes += cost
  }
  if (files.length > options.maxFiles) truncated = true
  return { spans, bytes, truncated }
}

function summarise(files: ReadonlyArray<{ path: string }>, shown: number, inScan: number): string {
  const paths = files.slice(0, 60).map((f) => f.path).join(', ')
  return `${shown} of ${inScan} scanned files are included below. Paths: ${paths}`
    + (inScan > 60 ? ', …' : '')
}

export interface HolisticInput {
  submissionId: number
  challengeId: number
  goldenSetId: number | null
  passIndex: 1 | 2
  actor: string
  runId?: number
}

export async function evaluateHolistically(input: HolisticInput): Promise<HolisticRow> {
  const scan = await selectLatestScan(input.submissionId)
  if (!scan || scan.status !== 'COMPLETED') {
    throw new AppError('PRECONDITION_FAILED',
      `Submission ${input.submissionId} has no completed scan, so there is nothing to show the `
      + 'model. The holistic pass reads the same scan the per-criterion pass does, so that the '
      + 'comparison is between two readings of one repository and not between two repositories.')
  }
  const brief = await selectBrief(input.challengeId)
  if (!brief) throw new AppError('NOT_FOUND', `Challenge ${input.challengeId} was not found.`)

  const raw = await selectRawResult(scan.scan_id)
  if (!raw) {
    throw new AppError('PRECONDITION_FAILED',
      `Scan ${scan.scan_id} has no stored result, so its files cannot be shown to the model.`)
  }
  const files = raw.files
  const { spans, bytes, truncated } = wholeRepoSpans(files, {
    budgetBytes: await getNumber('holistic.context_budget_bytes'),
    maxFiles: await getNumber('holistic.max_files'),
  })

  const base = {
    submission_id: input.submissionId, golden_set_id: input.goldenSetId,
    pass_index: input.passIndex, files_in_scan: files.length, files_shown: spans.length,
    context_bytes: bytes, context_truncated: truncated, evaluated_by: input.actor,
  }

  try {
    const result = await callModel({
      callKey: 'scoring.holistic',
      variables: {
        challenge_name: brief.name,
        brief_text: brief.brief_text ?? brief.description
          ?? 'No brief text was extracted for this challenge.',
        repo_summary: summarise(files, spans.length, files.length),
      },
      // The team's own code, fenced and labelled as data (P8.4) exactly as the scoring calls do.
      untrusted: spans,
      schema: holisticSchema,
      ...(input.runId !== undefined && { runId: input.runId }),
      subject: { type: 'submission', id: String(input.submissionId) },
    })

    const out = result.data
    log.info('holistic evaluation recorded', {
      submissionId: input.submissionId, passIndex: input.passIndex,
      overall: out.overall, contextBytes: bytes, filesShown: spans.length,
    })
    return upsertHolistic({
      ...base, model: result.model, overall: out.overall, non_score: out.non_score,
      verdict: out.verdict, reasoning: out.reasoning, strengths: out.strengths,
      weaknesses: out.weaknesses, evidence: out.evidence, confidence: out.confidence,
      injection_noted: out.injection_noted, costUsd: result.costUsd,
    })
  } catch (err) {
    // A failed evaluation is recorded as a failure, never as a zero. Same rule as a score.
    const message = err instanceof Error ? err.message : 'The evaluation could not be completed.'
    log.warn('holistic evaluation failed', { submissionId: input.submissionId, message })
    return upsertHolistic({
      ...base, model: 'unknown', overall: null, non_score: 'EVALUATION_FAILED',
      verdict: '', reasoning: message.slice(0, 4000), strengths: [], weaknesses: [], evidence: [],
      confidence: null, injection_noted: null, costUsd: 0,
    })
  }
}

/** Every linked entry of a golden set, one pass. Sequential: one whole repository at a time. */
export async function evaluateSetHolistically(input: {
  goldenSetId: number; passIndex: 1 | 2; actor: string
}): Promise<HolisticRow[]> {
  const subjects = await selectSetSubjects(input.goldenSetId)
  if (subjects.length === 0) {
    throw new AppError('PRECONDITION_FAILED',
      `Golden set ${input.goldenSetId} has no entry linked to a validated submission.`)
  }
  const rows: HolisticRow[] = []
  for (const subject of subjects) {
    rows.push(await evaluateHolistically({
      submissionId: subject.submission_id, challengeId: subject.challenge_id,
      goldenSetId: input.goldenSetId, passIndex: input.passIndex, actor: input.actor,
    }))
  }
  return rows
}
