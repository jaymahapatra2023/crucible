/**
 * The shortlist as CSV (E08-S05 acceptance 2).
 *
 * "Export includes rank, composite, dimensions, flags, overrides and reasons." All six, because
 * this file is what leaves the system — it gets mailed, printed and argued over long after the
 * screens are gone. A row that carries a decision without the reason for it, or a composite
 * without the caveats attached to it, is the version of the outcome that cannot be defended.
 */
import { csvDocument } from '../../../lib/csv.js'
import { AppError } from '../../../lib/appError.js'
import { query } from '../../../db/pool.js'
import { selectShortlist } from '../db/shortlistDb.js'
import { reviewTable } from './reviewTable.js'

const HEADER = [
  'rank_global', 'rank_in_challenge', 'submission_id', 'team_name', 'challenge_id',
  'composite',
  'challenge_fidelity', 'engineering_quality', 'principles_standards', 'runs', 'originality',
  'dimensions_not_scored', 'weight_covered_pct', 'partial',
  'normalisation_method', 'in_cut_band', 'requires_review',
  'open_flags', 'flag_codes', 'flag_messages', 'dismissed_flag_reasons',
  'decision', 'decision_reason', 'decided_by', 'decided_at', 'rank_at_decision',
  'shortlist_status', 'rubric_versions', 'exported_at',
] as const

interface FlagText {
  codes: string[]
  messages: string[]
  dismissals: string[]
}

export async function exportShortlist(runIndexId: number): Promise<string> {
  const shortlist = await selectShortlist(runIndexId)
  if (!shortlist) {
    throw new AppError(
      'NOT_FOUND',
      `Scoring run ${runIndexId} has no shortlist to export.`,
    )
  }

  // The whole field, not a page: an export bounded by a UI page size would silently omit teams.
  const table = await reviewTable({ runIndexId, limit: 500 })
  const flags = await flagText(runIndexId)
  const decisions = await decisionDetail(runIndexId)
  const exportedAt = new Date().toISOString()

  return csvDocument(HEADER, table.rows.map((row) => exportRow({
    row,
    flags: flags.get(row.submission_id) ?? { codes: [], messages: [], dismissals: [] },
    decision: decisions.get(row.submission_id),
    status: shortlist.status,
    rubricVersions: shortlist.rubric_versions,
    exportedAt,
  })))
}

type Row = Awaited<ReturnType<typeof reviewTable>>['rows'][number]
type DecisionDetail = Awaited<ReturnType<typeof decisionDetail>> extends Map<number, infer V>
  ? V : never

/**
 * One exported row.
 *
 * Every empty cell here is deliberate rather than a missing value: a dimension nobody could
 * score, or a decision nobody has taken, is left blank because a spreadsheet cannot tell a
 * zero that means "scored nothing" from a zero that means "not measured".
 */
function exportRow(input: {
  row: Row
  flags: FlagText
  decision: DecisionDetail | undefined
  status: string
  rubricVersions: Record<string, number>
  exportedAt: string
}): unknown[] {
  const { row, flags, decision } = input
  const dims = new Map(row.dimensions.map((d) => [d.dimension, d.score]))
  const dim = (name: string) => dims.get(name) ?? ''

  return [
    row.rank_global,
    row.rank_in_challenge,
    row.submission_id,
    row.team_name ?? '',
    row.challenge_id,
    row.composite,
    dim('CHALLENGE_FIDELITY'),
    dim('ENGINEERING_QUALITY'),
    dim('PRINCIPLES_STANDARDS'),
    dim('RUNS'),
    dim('ORIGINALITY'),
    row.missing_dimensions.join(' '),
    Math.round(Number(row.weight_covered) * 100),
    row.partial ? 'YES' : 'no',
    row.normalisation_method,
    row.in_cut_band ? 'YES' : 'no',
    row.requires_review ? 'YES' : 'no',
    row.open_flags,
    flags.codes.join(' '),
    // The full wording, not the codes: a reader of this file has no schema beside them.
    flags.messages.join(' | '),
    flags.dismissals.join(' | '),
    ...decisionCells(decision),
    input.status,
    JSON.stringify(input.rubricVersions),
    input.exportedAt,
  ]
}

/** The override and its reason, or five blanks when nobody has decided yet. */
function decisionCells(decision: DecisionDetail | undefined): unknown[] {
  if (!decision) return ['', '', '', '', '']
  return [
    decision.decision,
    decision.reason,
    decision.decided_by,
    decision.decided_at.toISOString(),
    decision.rank_at_decision ?? '',
  ]
}

async function flagText(runIndexId: number): Promise<Map<number, FlagText>> {
  const res = await query<{
    submission_id: number; code: string; message: string
    dismissed: boolean; dismissal_reason: string | null
  }>(
    `SELECT submission_id, code, message, dismissed, dismissal_reason
       FROM v_review_flags WHERE run_index_id = $1 ORDER BY submission_id, code`,
    [runIndexId])

  const out = new Map<number, FlagText>()
  for (const row of res.rows) {
    const entry = out.get(row.submission_id) ?? { codes: [], messages: [], dismissals: [] }
    if (row.dismissed) {
      // Kept, not dropped. A caveat a reviewer set aside is part of how the outcome was
      // reached, and the export is where that has to survive.
      entry.dismissals.push(`${row.code}: ${row.dismissal_reason ?? ''}`)
    } else {
      entry.codes.push(row.code)
      entry.messages.push(row.message)
    }
    out.set(row.submission_id, entry)
  }
  return out
}

async function decisionDetail(runIndexId: number): Promise<Map<number, {
  decision: string; reason: string; decided_by: string
  decided_at: Date; rank_at_decision: number | null
}>> {
  const res = await query<{
    submission_id: number; decision: string; reason: string; decided_by: string
    decided_at: Date; rank_at_decision: number | null
  }>(
    `SELECT submission_id, decision, reason, decided_by, decided_at, rank_at_decision
       FROM v_shortlist_decisions WHERE run_index_id = $1`,
    [runIndexId])
  return new Map(res.rows.map((r) => [r.submission_id, r]))
}
