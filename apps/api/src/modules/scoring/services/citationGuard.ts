/**
 * The semantic check every scoring call carries (E13-S02, P4.1 clause 3).
 *
 * P4.1 requires three validations before an LLM output is stored: schema, content, and semantic
 * — "output satisfies quality criteria for its type (e.g. a criterion score carries at least one
 * evidence reference with a path and a line range)". The schema enforces that a citation is
 * PRESENT. This enforces that it is TRUE.
 *
 * The rule, and why it is this strict: a response containing any contradicted citation fails
 * entirely. Not "keep the score and drop the bad citation" — a response that fabricated one
 * citation has not earned trust in the rest of itself, and a score whose evidence was quietly
 * pruned is exactly the unfalsifiable artefact this system exists to avoid.
 */
import { verifyCitations, type CitationInput, type CitationSummary } from '@crucible/scoring'
import type { ScanResult } from '@crucible/scanner'
import { createLogger } from '../../../lib/logger.js'
import { getNumber } from '../../platform/services/configService.js'
import type { SemanticVerdict } from '../../llm/types/llmTypes.js'

const log = createLogger('scoring', 'citationGuard')

/** The evidence shape every scoring schema shares. */
export interface RawEvidence {
  path: string
  line_start: number
  line_end: number
  excerpt: string
}

export const toCitation = (e: RawEvidence): CitationInput => ({
  path: e.path,
  lineStart: e.line_start,
  lineEnd: e.line_end,
  excerpt: e.excerpt,
})

export async function citationOptions() {
  return { drift: await getNumber('scoring.citation_line_drift') }
}

/**
 * Build the check a scoring call hands to the gateway.
 *
 * Returns a synchronous function because the gateway runs it inside the attempt loop; the
 * configured drift is resolved once, here, rather than on every citation.
 */
export function citationGuard(
  scan: ScanResult,
  options: { drift: number },
  context: { callKey: string; subject: string },
): (output: { evidence?: RawEvidence[] }) => SemanticVerdict {
  return (output) => {
    const evidence = output.evidence ?? []
    if (evidence.length === 0) return { ok: true }

    const summary = verifyCitations(evidence.map(toCitation), scan, options)
    if (!summary.anyContradicted) return { ok: true }

    const reasons = summary.checks
      .filter((c) => c.verdict === 'CONTRADICTED')
      .map((c) => c.reason)

    log.warn('scoring output cited something the scan contradicts', {
      ...context, contradicted: summary.contradicted, reasons,
    })

    return {
      ok: false,
      failure: 'CITATION_UNVERIFIED',
      error:
        `${summary.contradicted} of ${summary.checks.length} citations could not be found in `
        + `the scanned source: ${reasons.join(' ')}`,
    }
  }
}

/** The stored verdicts for evidence that did survive, for the reviewer and the appeal packet. */
export function checkEvidence(
  evidence: readonly RawEvidence[],
  scan: ScanResult,
  options: { drift: number },
): CitationSummary {
  return verifyCitations(evidence.map(toCitation), scan, options)
}

export interface CheckedEvidence {
  path: string
  lineStart: number
  lineEnd: number
  excerpt: string
  verdict: string
  verdictReason: string
}

/**
 * Stored evidence, each item carrying the verdict of checking it.
 *
 * One mapper for every evaluator rather than a copy per caller: a reader of an appeal packet
 * should not have to learn two evidence formats, and two mappers are how the two drift.
 */
export function withVerdicts(
  evidence: readonly RawEvidence[],
  scan: ScanResult,
  options: { drift: number },
): CheckedEvidence[] {
  const summary = checkEvidence(evidence, scan, options)
  return evidence.map((e, i) => ({
    path: e.path,
    lineStart: e.line_start,
    lineEnd: e.line_end,
    excerpt: e.excerpt,
    verdict: summary.checks[i]?.verdict ?? 'UNVERIFIABLE',
    verdictReason: summary.checks[i]?.reason ?? 'Not checked.',
  }))
}
