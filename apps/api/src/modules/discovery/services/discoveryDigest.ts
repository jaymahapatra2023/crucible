/**
 * Discovery findings as context for an evaluator (E12, ADR 0003).
 *
 * The evaluation reads from discovery: the principles, standards and security passes see what
 * the extractors found alongside the source excerpts they already get. Two rules hold it honest,
 * and both are enforced here rather than left to each caller:
 *
 *  1. ADDITIONAL, NEVER INSTEAD. The digest is appended to a context that already contains real
 *     source. An evaluator that scored from this alone would be grading a summary of the work —
 *     exactly the defect E06-S01 exists to fix.
 *
 *  2. A CONCERN THAT COULD NOT BE EXTRACTED IS PASSED AS ABSENT, NEVER AS "NONE FOUND". If the
 *     integrations extractor failed, the digest says the integrations are unknown. Rendering it
 *     as an empty list would let an evaluator conclude a team integrates with nothing, and mark
 *     them for it.
 *
 * Returns an empty string when there is no discovery, so a caller can pass it unconditionally
 * and an evaluator sees no discovery section at all rather than an empty one.
 */
import { conflictsFor, currentDiscovery, findingsFor } from '../db/discoveryDb.js'
import { CONCERNS, type ConcernResult } from './discoveryConcerns.js'

/** How many findings of each kind reach a prompt. Beyond this the tail is not read. */
const PER_KIND = 25

export async function discoveryDigest(submissionId: number): Promise<string> {
  const run = await currentDiscovery(submissionId)
  if (!run || run.status !== 'COMPLETED') return ''

  const [findings, conflicts] = await Promise.all([
    findingsFor(submissionId), conflictsFor(submissionId),
  ])
  const concerns = run.concerns as Record<string, ConcernResult | undefined>

  const sections: string[] = [
    'This is what a separate discovery pass extracted from the same repository. Treat it as a '
    + 'map of where things are, not as evidence in itself: cite the source excerpts above for '
    + 'anything you conclude. Where a concern is listed as NOT DETERMINED, it means the pass '
    + 'could not read enough to answer — it does NOT mean the repository has none, and you must '
    + 'not treat it as an absence.',
  ]

  for (const concern of CONCERNS) {
    const recorded = concerns[concern.key]
    const outcome = recorded?.outcome ?? 'FAILED'
    const heading = concern.target.name.toUpperCase()

    if (outcome === 'INSUFFICIENT_EVIDENCE' || outcome === 'FAILED') {
      sections.push(`${heading}: NOT DETERMINED. ${recorded?.note ?? ''}`.trim())
      continue
    }
    if (outcome === 'NONE_FOUND') {
      sections.push(`${heading}: none were found in the files that were read.`)
      continue
    }

    const lines = concern.key === 'claims'
      ? conflicts.slice(0, PER_KIND).map((c) => `- documentation says "${c.claim}" (${c.claim_path}); code shows: ${c.observed}`)
      : findings.filter((f) => f.kind === concern.kind).slice(0, PER_KIND)
        .map(describeFinding)

    if (lines.length === 0) {
      sections.push(`${heading}: NOT DETERMINED.`)
      continue
    }
    sections.push(`${heading}\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}

/**
 * One finding, as an evaluator reads it.
 *
 * An observation a reviewer has checked and set aside is MARKED rather than dropped. Dropping
 * it would hide that anyone looked; leaving it unmarked would feed an evaluator something a
 * person has already determined is benign, and let it weigh against the team a second time.
 */
function describeFinding(f: {
  label: string; summary: string; path: string; line_start: number | null
  dismissed?: boolean; dismissal_reason?: string | null
}): string {
  const at = `[${f.path}${f.line_start ? `:${f.line_start}` : ''}]`
  const base = `- ${f.label}${f.summary ? ` — ${f.summary}` : ''} ${at}`
  return f.dismissed
    ? `${base} (CHECKED BY A REVIEWER AND SET ASIDE: ${f.dismissal_reason ?? 'no longer a concern'} `
      + `— do not weigh this against the submission)`
    : base
}

/**
 * The same digest, or an explicit statement that there is none.
 *
 * Prompt templates cannot render a missing variable, and a blank would read as "discovery found
 * nothing" rather than "discovery was not run". Callers substituting into a template use this.
 */
export async function discoveryDigestOrAbsent(submissionId: number): Promise<string> {
  const digest = await discoveryDigest(submissionId)
  return digest === ''
    ? 'No discovery pass has been run on this repository. You have the source excerpts and '
      + 'nothing else. That is not a deficiency in the submission and must not count against it.'
    : digest
}
