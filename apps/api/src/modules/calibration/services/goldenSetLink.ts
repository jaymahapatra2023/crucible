/**
 * Connecting a ranked repository to the submission the machine scored (E21).
 *
 * `golden_entry.submission_id` is what makes a calibration report possible: without it the
 * report has a human ordering and no machine ordering to compare it against, and refuses. The
 * column existed, `linkSubmission` existed, and **nothing called either** — so the gate could be
 * set up completely and then never produced a report. The integration test reached the report by
 * calling the database layer directly, which is why a green suite hid it.
 *
 * Matching is by canonicalised repository URL, using the same `checkUrl` the intake path uses,
 * so "the same repository" means one thing in this system rather than two.
 *
 * It refuses a partial match. A report over five of the nine repositories the committee ranked
 * is not a report about that golden set — and the correlation it produced would carry the set's
 * name while answering a different question.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { checkUrl } from '../../submissions/services/repoValidation.js'
import {
  linkSubmission, selectCurrentSubmissionRepos, selectEntries,
} from '../db/calibrationDb.js'
import { requireSet } from './goldenSetService.js'

const log = createLogger('calibration', 'link')

export const LINK_OUTCOMES = [
  'MATCHED', 'ALREADY_LINKED', 'NO_SUBMISSION', 'AMBIGUOUS', 'UNREADABLE',
] as const
export type LinkOutcome = (typeof LINK_OUTCOMES)[number]

export interface LinkRow {
  entryId: number
  label: string
  repoUrl: string
  expectedBand: string
  edgeCase: string | null
  submissionId: number | null
  teamName: string | null
  outcome: LinkOutcome
  detail: string | null
}

export interface LinkPlan {
  rows: LinkRow[]
  summary: { total: number; resolved: number; unresolved: number }
  /** True only when links were written. */
  linked: boolean
  /** Set when a confirmed link was refused, saying what has to be fixed. */
  refusal: string | null
}

const RESOLVED: readonly LinkOutcome[] = ['MATCHED', 'ALREADY_LINKED']
const isResolved = (row: LinkRow) => RESOLVED.includes(row.outcome)

/**
 * Work out which submission each entry refers to, and optionally record it.
 *
 * `confirm: false` writes nothing. The plan is computed identically either way, so what an
 * organiser approves is what runs.
 */
export async function linkGoldenSet(input: {
  goldenSetId: number
  /**
   * Narrow the search to one challenge.
   *
   * The same repository under two challenges is a legitimate state — rebuilding a golden set
   * against a revised rubric produces exactly it — and a URL then identifies a repository but
   * not which submission of it this set means. Without this the matching is AMBIGUOUS for every
   * shared entry, which is honest and useless.
   */
  challengeId?: number
  confirm: boolean
  actor: string
}): Promise<LinkPlan> {
  await requireSet(input.goldenSetId)

  const entries = await selectEntries(input.goldenSetId)
  if (entries.length === 0) {
    throw new AppError('PRECONDITION_FAILED',
      'This golden set has no entries to link. Add the repositories first.')
  }

  const normalised = await Promise.all(entries.map(async (e) => ({
    entry: e, url: await canonical(e.repo_url),
  })))

  // Both sides through the same canonicaliser. A submission that has not validated yet still
  // holds what was pasted, so comparing raw strings would miss exactly the entries an organiser
  // is most likely to be chasing.
  const byUrl = new Map<string, Array<{ submissionId: number; teamName: string }>>()
  for (const candidate of await selectCurrentSubmissionRepos(input.challengeId)) {
    const url = await canonical(candidate.repoUrl)
    if (url === null) continue
    const list = byUrl.get(url) ?? []
    list.push({ submissionId: candidate.submissionId, teamName: candidate.teamName })
    byUrl.set(url, list)
  }

  const rows = normalised.map(({ entry, url }) => decide(entry, url, byUrl, input.challengeId))
  const unresolved = rows.filter((r) => !isResolved(r))

  if (!input.confirm) return plan(rows, false, null)

  if (unresolved.length > 0) {
    return plan(rows, false,
      `Nothing was linked. ${unresolved.length} of ${rows.length} entries have no submission to `
      + `compare against, and a report over the rest would carry this set's name while answering `
      + `a different question.`)
  }

  const toWrite = rows.filter((r) => r.outcome === 'MATCHED')
  for (const row of toWrite) await linkSubmission(row.entryId, row.submissionId)

  if (toWrite.length > 0) {
    await recordAudit({
      actor: input.actor, action: 'calibration.entries_linked',
      subjectType: 'golden_set', subjectId: String(input.goldenSetId),
      payload: {
        linked: toWrite.length,
        pairs: toWrite.map((r) => ({ entryId: r.entryId, submissionId: r.submissionId })),
      },
    })
    log.info('golden set entries linked', {
      goldenSetId: input.goldenSetId, linked: toWrite.length,
    })
  }

  return plan(rows.map((r) => r.outcome === 'MATCHED' ? { ...r, outcome: 'ALREADY_LINKED' as const } : r),
    true, null)
}

function decide(
  entry: { entry_id: number; label: string; repo_url: string; expected_band: string
           edge_case: string | null; submission_id: number | null },
  url: string | null,
  byUrl: Map<string, Array<{ submissionId: number; teamName: string }>>,
  challengeId: number | undefined,
): LinkRow {
  const base = {
    entryId: Number(entry.entry_id), label: entry.label, repoUrl: entry.repo_url,
    expectedBand: entry.expected_band, edgeCase: entry.edge_case,
    submissionId: null as number | null, teamName: null as string | null,
  }

  if (entry.submission_id !== null) {
    return {
      ...base, outcome: 'ALREADY_LINKED', submissionId: Number(entry.submission_id),
      teamName: null,
      detail: `Already linked to submission ${entry.submission_id}.`,
    }
  }

  if (url === null) {
    return {
      ...base, outcome: 'UNREADABLE',
      detail: `'${entry.repo_url}' is not a repository URL this system accepts, so it cannot be `
        + `matched to a submission. Correct it on the entry.`,
    }
  }

  const found = byUrl.get(url) ?? []
  if (found.length === 0) {
    return {
      ...base, outcome: 'NO_SUBMISSION',
      detail: challengeId === undefined
        ? 'No current submission points at this repository. Enter it on the team\'s behalf, so '
          + 'it is scanned, probed and scored by the same path as a real entry.'
        : `No current submission for challenge ${challengeId} points at this repository. `
          + `Enter it on that challenge, or link without narrowing to one.`,
    }
  }
  if (found.length > 1) {
    // Two teams submitting the same repository is possible, and picking one would put a guess
    // into the evidence the gate rests on.
    return {
      ...base, outcome: 'AMBIGUOUS',
      detail: `${found.length} current submissions point at this repository `
        + `(${found.map((f) => `#${f.submissionId} ${f.teamName}`).join(', ')}). `
        + `Resolve which one this entry is before linking.`,
    }
  }

  return {
    ...base, outcome: 'MATCHED',
    submissionId: found[0]!.submissionId, teamName: found[0]!.teamName,
    detail: null,
  }
}

function plan(rows: LinkRow[], linked: boolean, refusal: string | null): LinkPlan {
  const resolved = rows.filter(isResolved).length
  return {
    rows,
    summary: { total: rows.length, resolved, unresolved: rows.length - resolved },
    linked,
    refusal,
  }
}

/** The same canonical form intake stores, so "the same repository" means one thing (P1.5). */
async function canonical(repoUrl: string): Promise<string | null> {
  const checked = await checkUrl(repoUrl)
  return checked.ok ? checked.normalised : null
}
