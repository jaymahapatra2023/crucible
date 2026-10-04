/**
 * Running one discovery concern against one scan (E12).
 *
 * Isolated deliberately. Each concern selects its own evidence, makes its own model call, and
 * fails on its own: a security extractor that times out must not cost a reviewer the endpoint
 * list that extracted perfectly. The outcome it returns distinguishes four states that a naive
 * implementation collapses into "empty":
 *
 *   FOUND                 — the extractor read the code and found these.
 *   NONE_FOUND            — the extractor read the code and there are none.
 *   INSUFFICIENT_EVIDENCE — the files it was shown could not answer the question.
 *   FAILED                — the call did not complete.
 *
 * Only the first two are statements about the submission. Presenting either of the last two as
 * "0" would tell a reviewer something false about a team's work (P5.1).
 */
import { buildContext, verifyCitation, type ScoringContext } from '@crucible/scoring'
import type { ScanResult } from '@crucible/scanner'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { getNumber } from '../../platform/services/configService.js'
import { callModel } from '../../llm/services/llmGateway.js'
import type { Concern, ConcernResult } from './discoveryConcerns.js'
import { mapFindings, mapConflicts, type MappedFinding } from './discoveryMappers.js'
import type { ClaimsOutput } from './discoverySchemas.js'

const log = createLogger('discovery', 'extractor')

export interface ExtractionOutput {
  result: ConcernResult
  findings: MappedFinding[]
  conflicts: ReturnType<typeof mapConflicts>
}

/**
 * Findings whose citation the scan contradicts, removed (E13-S03).
 *
 * Discovery is handled differently from scoring, and the difference is structural. A criterion
 * is ONE judgement, so a fabricated citation taints it and the whole response is retried. A
 * concern is a LIST, so one bad entry taints one entry — losing twenty verified endpoints
 * because the twenty-first was wrong would be its own kind of dishonesty.
 *
 * What is not acceptable is removing it silently. A finding that disappears without trace is an
 * unrecorded edit to the evidence, so the count travels with the concern.
 */
function dropContradicted(
  findings: MappedFinding[], scan: ScanResult, drift: number,
): { kept: MappedFinding[]; rejected: number } {
  const kept: MappedFinding[] = []
  let rejected = 0

  for (const finding of findings) {
    const check = verifyCitation({
      path: finding.path,
      lineStart: finding.line_start,
      lineEnd: finding.line_end,
      excerpt: finding.excerpt,
    }, scan, { drift })

    if (check.verdict === 'CONTRADICTED') {
      rejected++
      log.warn('discovery finding cited something the scan contradicts', {
        kind: finding.kind, label: finding.label, path: finding.path, reason: check.reason,
      })
      continue
    }
    // UNVERIFIABLE is kept and labelled: a budget that stopped short is a fact about our
    // reading, not about the submission. RELOCATED is kept too, with the line numbers CORRECTED
    // to where the quoted text actually is — storing the cited ones would leave a finding
    // pointing at code the team did not write.
    const at = check.corrected
    kept.push({
      ...finding,
      ...(at ? { line_start: at.lineStart, line_end: at.lineEnd } : {}),
      detail: { ...finding.detail, citation_verdict: check.verdict },
    })
  }

  return { kept, rejected }
}

export async function discoveryContextOptions() {
  return {
    budgetBytes: await getNumber('discovery.context_budget_bytes'),
    // Discovery reads breadth, not depth: a wider window would spend the budget on fewer files
    // and an API surface spread over twenty of them would be read from four.
    windowLines: 8,
    maxFiles: await getNumber('discovery.max_files'),
    // Lower than scoring's floor. A criterion asks a narrow question and a weak match is noise;
    // a concern asks "what is here", where a weak match is often the only file that has it.
    minRelevance: 6,
  }
}

export interface RunConcernInput {
  concern: Concern
  scan: ScanResult
  /** Line tolerance when checking a finding's citation against the scan (E13). */
  drift: number
  submissionId: number
  runId?: number | undefined
  /** What the code extractors found. Only `claims` receives it. */
  codeFindings?: string | undefined
}

export async function runConcern(input: RunConcernInput): Promise<ExtractionOutput> {
  const { concern, scan, submissionId } = input
  const empty: ExtractionOutput = {
    result: { outcome: 'FAILED', count: 0, note: '', costUsd: 0, model: null },
    findings: [], conflicts: [],
  }

  const context = buildContext(concern.target, scan, await discoveryContextOptions())

  if (context.insufficientEvidence) {
    return {
      ...empty,
      result: {
        outcome: 'INSUFFICIENT_EVIDENCE', count: 0, costUsd: 0, model: null,
        note: context.insufficientReason
          ?? `No file in the scan related to ${concern.target.name.toLowerCase()}.`,
      },
    }
  }

  try {
    const call = await callModel({
      callKey: concern.callKey,
      variables: {
        repo_summary: context.repoSummary,
        ...(input.codeFindings !== undefined && { code_findings: input.codeFindings }),
      },
      // The team's own code: fenced, labelled and scanned as data, never as instruction (P8.4).
      untrusted: excerptSpans(context),
      schema: concern.schema,
      ...(input.runId !== undefined && { runId: input.runId }),
      subject: { type: 'submission', id: String(submissionId) },
    })

    const output = call.data as { insufficient_evidence: boolean; note: string }
    const shared = { costUsd: call.costUsd, model: call.model }

    if (output.insufficient_evidence) {
      return {
        ...empty,
        result: { outcome: 'INSUFFICIENT_EVIDENCE', count: 0, note: output.note, ...shared },
      }
    }

    return classify(concern, output, { scan, drift: input.drift, shared })
  } catch (err) {
    log.error('discovery concern failed', { concern: concern.key, submissionId, err })
    return {
      ...empty,
      result: {
        outcome: 'FAILED', count: 0, costUsd: 0, model: null,
        note: `This concern could not be extracted: ${errorMessage(err)}`,
      },
    }
  }
}

/**
 * What a concern's output means, once its citations have been checked.
 *
 * Kept out of `runConcern` so that function reads as "select evidence, call, classify" and this
 * one holds every rule about what an empty or rejected result signifies.
 */
function classify(
  concern: Concern,
  output: { insufficient_evidence: boolean; note: string },
  ctx: { scan: ScanResult; drift: number; shared: { costUsd: number; model: string } },
): ExtractionOutput {
  const { scan, drift, shared } = ctx
  const mapped = concern.kind ? mapFindings(concern.key, output) : []
  const { kept: findings, rejected } = dropContradicted(mapped, scan, drift)
  const conflicts = concern.key === 'claims'
    ? mapConflicts(output as unknown as ClaimsOutput).filter((c) => keepConflict(c, scan, drift))
    : []
  const count = concern.kind ? findings.length : conflicts.length

  // Everything it returned was contradicted by the source. That tells us nothing about the
  // repository, so it is a failure of the extractor rather than an empty repository.
  if (rejected > 0 && count === 0 && concern.kind) {
    return {
      result: {
        outcome: 'FAILED', count: 0, ...shared,
        note: `All ${rejected} findings cited source that does not exist in the scanned `
          + `commit, so none could be kept.`,
      },
      findings: [], conflicts: [],
    }
  }

  // Zero from an extractor that read the code means different things per concern. An
  // application really can integrate with nothing; one really cannot have no data model.
  const outcome = count > 0
    ? 'FOUND'
    : concern.emptyIsMeaningful ? 'NONE_FOUND' : 'INSUFFICIENT_EVIDENCE'
  const base = count > 0 ? output.note
    : concern.emptyIsMeaningful
      ? output.note || 'None found in the files that were read.'
      : `The extractor read the code and returned nothing for ${concern.target.name.toLowerCase()}. `
        + `Recorded as unknown rather than as none: an absence here is more often a gap in `
        + `what was read than a fact about the submission.`

  const note = rejected === 0 ? base
    : `${base} ${rejected} further finding${rejected === 1 ? '' : 's'} cited source that does `
      + `not exist in the scanned commit and ${rejected === 1 ? 'was' : 'were'} dropped.`

  return { result: { outcome, count, note: note.trim(), ...shared }, findings, conflicts }
}

/**
 * Whether a claim conflict quotes documentation that actually says that.
 *
 * Dropped rather than retried, for the same reason a finding is: one unfounded conflict should
 * not cost the reviewer the others. Unverifiable is kept — a README outside the scan budget is
 * a limit of our reading, and the conflict may well be sound.
 */
function keepConflict(
  conflict: { claim: string; claim_path: string; claim_line: number | null },
  scan: ScanResult,
  drift: number,
): boolean {
  const check = verifyCitation({
    path: conflict.claim_path,
    lineStart: conflict.claim_line,
    lineEnd: conflict.claim_line,
    excerpt: conflict.claim,
  }, scan, { drift })

  if (check.verdict !== 'CONTRADICTED') return true
  log.warn('claim conflict quotes documentation that does not say that', {
    claim: conflict.claim, path: conflict.claim_path, reason: check.reason,
  })
  return false
}

/** Each excerpt as its own labelled, fenced span, so a finding can cite a location precisely. */
function excerptSpans(context: ScoringContext): Array<{ label: string; content: string }> {
  return context.excerpts.map((e) => ({
    label: `${e.path}:${e.lineStart}-${e.lineEnd}`,
    content: e.text,
  }))
}
