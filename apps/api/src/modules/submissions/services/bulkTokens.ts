/**
 * Registering a cohort of teams from one file (E20).
 *
 * Issuing a token IS registering a team (E17-S01), so bulk registration is bulk issue. The thing
 * that makes it more than a loop is the plaintext: a token is shown once and only its SHA-256 is
 * stored, so fifty tokens returned in one response are fifty chances to lose a team's entry.
 *
 * Two decisions follow from that, and both are about refusing rather than half-doing:
 *
 *   * **Nothing is written until the file is whole.** The plan is computed and returned first;
 *     a file with a bad row is refused entirely, naming every bad row. An operator fixes the
 *     file and retries with nothing half-registered behind them.
 *   * **Issue is one transaction.** Twenty teams created and the twenty-first failing would
 *     leave twenty plaintexts that were never returned — tokens that exist, belong to teams,
 *     and nobody holds.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { query, tx } from '../../../db/pool.js'
import { CsvError, csvDocument, headerIndex, parseCsv } from '../../../lib/csv.js'
import { getNumber } from '../../platform/services/configService.js'
import { issueSubmissionToken } from './submissionTokens.js'
import { listTeams } from '../db/teamDb.js'
import {
  assertDeliverable, prepareDelivery, type Deliverable, type DeliveryReport,
} from './tokenDelivery.js'

const log = createLogger('submissions', 'bulkTokens')

const COLUMNS = {
  team_name: ['team_name', 'team', 'name'],
  contact_email: ['contact_email', 'email', 'contact'],
} as const

/** Matches the single-issue form and the `submission.contact_email` column. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const BULK_OUTCOMES = ['NEW', 'EXISTING', 'INVALID', 'DUPLICATE'] as const
export type BulkOutcome = (typeof BULK_OUTCOMES)[number]

export interface BulkRow {
  line: number
  teamName: string
  contactEmail: string
  outcome: BulkOutcome
  /** Why, for everything except a plain NEW. Always set when the row cannot be acted on. */
  detail: string | null
  teamId: number | null
  /** The plaintext, on a confirmed issue only. The one moment it exists. */
  token: string | null
  /** Which token this is, so a delivery can be recorded against it without storing the secret. */
  tokenId: number | null
  /** The contact's Discord id when the team has one (E49); DMs go there first. */
  discordUserId?: string | null
}

export interface BulkPlan {
  rows: BulkRow[]
  summary: Record<Lowercase<BulkOutcome>, number> & { total: number }
  /** True only when tokens were actually issued. */
  issued: boolean
  /** Set when a confirmed issue was refused, saying what has to be fixed. */
  refusal: string | null
  /** Present only when delivery was asked for in the same act (E34). */
  delivery?: DeliveryReport
}

/**
 * Hand the freshly issued tokens to the mailer, in the act that created them.
 *
 * It has to be here. A token's plaintext exists only inside this response (P8.3), so a later job
 * would have nothing to send — delivery is either part of issuing or it is reissuing.
 */
export async function deliverIssued(
  rows: readonly BulkRow[], actor: string,
): Promise<DeliveryReport> {
  const deliverables: Deliverable[] = rows
    .filter((r) => r.token !== null && r.tokenId !== null && r.teamId !== null)
    .map((r) => ({
      teamId: r.teamId!, tokenId: r.tokenId!, teamName: r.teamName,
      contactEmail: r.contactEmail, token: r.token!, discordUserId: r.discordUserId ?? null,
    }))

  assertDeliverable(deliverables)
  return prepareDelivery({ deliverables, actor })
}

const blocked = (rows: BulkRow[]) =>
  rows.filter((r) => r.outcome === 'INVALID' || r.outcome === 'DUPLICATE')

/**
 * Read the file and say what issuing it would do, without doing it.
 *
 * `confirm` turns the same plan into writes. The plan is computed identically either way, so what
 * an operator approves is what runs.
 */
export async function bulkIssue(input: {
  csv: string
  confirm: boolean
  actor: string
}): Promise<BulkPlan> {
  const rows = await planRows(input.csv)
  const problems = blocked(rows)

  if (!input.confirm) return plan(rows, false, null)

  if (problems.length > 0) {
    // Refused whole. Issuing the good rows would leave the operator reconciling which of their
    // teams exist against a file that does not say.
    return plan(rows, false,
      `Nothing was issued. ${problems.length} of ${rows.length} rows cannot be acted on — `
      + `fix them and upload the file again.`)
  }

  const issuedRows = await tx(async (client) => {
    const out: BulkRow[] = []
    for (const row of rows) {
      const issued = await issueSubmissionToken({
        label: row.teamName,
        ...(row.teamId !== null && { teamId: row.teamId }),
        contactEmail: row.contactEmail,
        issuedBy: input.actor,
        client,
      })
      out.push({ ...row, teamId: issued.teamId, token: issued.token, tokenId: issued.tokenId })
    }
    return out
  })

  await recordAudit({
    actor: input.actor, action: 'submissions.tokens_bulk_issued', subjectType: 'access_token',
    subjectId: 'bulk',
    // Counts and team ids only. A token never reaches a log or an audit payload (P8.3).
    payload: {
      issued: issuedRows.length,
      created: issuedRows.filter((r) => r.outcome === 'NEW').length,
      reissued: issuedRows.filter((r) => r.outcome === 'EXISTING').length,
      teamIds: issuedRows.map((r) => r.teamId),
    },
  })
  log.info('bulk tokens issued', { count: issuedRows.length, actor: input.actor })

  return plan(issuedRows, true, null)
}

function plan(rows: BulkRow[], issued: boolean, refusal: string | null): BulkPlan {
  const count = (o: BulkOutcome) => rows.filter((r) => r.outcome === o).length
  return {
    rows,
    summary: {
      total: rows.length, new: count('NEW'), existing: count('EXISTING'),
      invalid: count('INVALID'), duplicate: count('DUPLICATE'),
    },
    issued,
    refusal,
  }
}

/** Parse, validate, and decide each row's outcome against what is already in the database. */
async function planRows(csv: string): Promise<BulkRow[]> {
  // Checked before parsing: a file of nothing but whitespace parses as one blank-ish row and
  // would otherwise be refused for a missing column, which reads as though the header is wrong
  // rather than as though the file is empty.
  if (csv.trim() === '') {
    throw new AppError('VALIDATION_FAILED',
      'That file is empty. It needs a header naming team_name and contact_email, then one row '
      + 'per team.')
  }

  let records
  try {
    records = parseCsv(csv)
  } catch (err) {
    if (err instanceof CsvError) {
      throw new AppError('VALIDATION_FAILED', `Line ${err.line}: ${err.message}`)
    }
    throw err
  }

  if (records.length === 0) {
    throw new AppError('VALIDATION_FAILED',
      'That file has no rows. It needs a header naming team_name and contact_email, then one '
      + 'row per team.')
  }

  const header = headerIndexOrFail(records[0]!.cells)
  const body = records.slice(1)

  if (body.length === 0) {
    throw new AppError('VALIDATION_FAILED',
      'That file has a header and no teams under it.')
  }

  const max = await getNumber('submissions.max_bulk_tokens')
  if (body.length > max) {
    throw new AppError('VALIDATION_FAILED',
      `That file has ${body.length} teams and at most ${max} may be registered at once. Split `
      + `it, or raise submissions.max_bulk_tokens.`)
  }

  const raw = body.map((record) => ({
    line: record.line,
    teamName: (record.cells[header['team_name']!] ?? '').trim(),
    contactEmail: (record.cells[header['contact_email']!] ?? '').trim(),
  }))

  // Normalisation comes from the database function the stored column is generated from, so
  // "already in the file" and "already in the database" mean exactly the same thing (P1.5
  // clause 6). Computing it here in TypeScript would be a second definition.
  const normalised = await normaliseAll(raw.map((r) => r.teamName))
  const existing = await existingTeams(normalised)

  const seen = new Map<string, number>()
  return raw.map((row, i) => decide(row, normalised[i] ?? '', existing, seen))
}

function headerIndexOrFail(header: string[]): Record<string, number> {
  try {
    return headerIndex(header, COLUMNS)
  } catch (err) {
    if (err instanceof CsvError) throw new AppError('VALIDATION_FAILED', err.message)
    throw err
  }
}

function decide(
  row: { line: number; teamName: string; contactEmail: string },
  normalised: string,
  existing: Map<string, { teamId: number; displayName: string }>,
  seen: Map<string, number>,
): BulkRow {
  const base = { ...row, teamId: null, token: null, tokenId: null }

  const problem = rowProblem(row)
  if (problem) return { ...base, outcome: 'INVALID', detail: problem }

  const earlier = seen.get(normalised)
  if (earlier !== undefined) {
    return {
      ...base, outcome: 'DUPLICATE',
      detail: `The same team appears on line ${earlier}. Registering it twice would create two `
        + `teams that rank separately.`,
    }
  }
  seen.set(normalised, row.line)

  const match = existing.get(normalised)
  if (match) {
    return {
      ...base, outcome: 'EXISTING', teamId: match.teamId,
      detail: `Already registered as "${match.displayName}". This issues a REPLACEMENT token for `
        + `that team — their entry and version history are kept.`,
    }
  }
  return { ...base, outcome: 'NEW', detail: null }
}

function rowProblem(row: { teamName: string; contactEmail: string }): string | null {
  if (row.teamName.length < 2) return 'The team name is missing, or too short to be one.'
  if (row.teamName.length > 120) return 'The team name is longer than 120 characters.'
  if (row.contactEmail === '') {
    return 'The contact email is missing. It is the only way to reach a team whose repository '
      + 'will not clone, and they have no account.'
  }
  if (!EMAIL.test(row.contactEmail)) return `"${row.contactEmail}" is not an email address.`
  return null
}

/** One round trip, using the database's own normalisation for every name in the file. */
async function normaliseAll(names: string[]): Promise<string[]> {
  if (names.length === 0) return []
  const res = await query<{ idx: number; normalised: string }>(
    `SELECT idx::int AS idx, team_normalise(name) AS normalised
       FROM unnest($1::text[]) WITH ORDINALITY AS t(name, idx)`,
    [names])

  const byIndex = new Map(res.rows.map((r) => [Number(r.idx), r.normalised]))
  return names.map((_, i) => byIndex.get(i + 1) ?? '')
}

async function existingTeams(
  normalised: string[],
): Promise<Map<string, { teamId: number; displayName: string }>> {
  const wanted = normalised.filter((n) => n !== '')
  if (wanted.length === 0) return new Map()

  const res = await query<{ team_id: number; display_name: string; normalised_name: string }>(
    `SELECT team_id, display_name, normalised_name FROM team
      WHERE normalised_name = ANY($1) ORDER BY team_id`,
    [wanted])

  const map = new Map<string, { teamId: number; displayName: string }>()
  for (const r of res.rows) {
    // First wins. Where the backfill left two teams under one normalised name — the same name
    // under two challenges — reissuing for the older is the conservative choice, and the plan
    // shows which team it matched so an operator can correct it.
    if (!map.has(r.normalised_name)) {
      map.set(r.normalised_name, { teamId: Number(r.team_id), displayName: r.display_name })
    }
  }
  return map
}

/**
 * The file an operator sends out from.
 *
 * Built here rather than in the browser so there is one definition of the delivery format, and
 * because it is the only artifact carrying the plaintexts — it must be right the first time.
 */
export function toCsv(plan: BulkPlan): string {
  return csvDocument(
    ['team_name', 'contact_email', 'token', 'status'],
    plan.rows.map((row) => [
      row.teamName, row.contactEmail, row.token ?? '',
      row.outcome === 'EXISTING' ? 'replacement' : 'new',
    ]),
  )
}

/**
 * Issue a token for every team that has none (E29-S01).
 *
 * The file-driven path above exists for a cohort that does not have teams yet. Once the roster has
 * built them — which is the usual order now — there is no file to assemble, and asking an
 * organiser to export forty team names in order to re-import them would be work invented by the
 * tool rather than required by the job.
 *
 * A team that already holds an active token is reported and **not** reissued. Two live tokens per
 * team is two answers to "who submitted this", and a second one would not make the first stop
 * working.
 */
export async function issueForTeamsWithout(input: {
  confirm: boolean
  actor: string
}): Promise<BulkPlan> {
  const all = await listTeams()

  const rows: BulkRow[] = all.map((team) => ({
    line: 0,
    teamName: team.displayName,
    contactEmail: team.contactEmail,
    outcome: team.activeTokens > 0 ? 'EXISTING' : 'NEW',
    detail: team.activeTokens > 0
      ? `Already holds ${team.activeTokens} working token${team.activeTokens === 1 ? '' : 's'}. `
        + `Revoke one before reissuing, so there is only ever one answer to who submitted.`
      : null,
    teamId: team.teamId,
    token: null,
    tokenId: null,
    discordUserId: team.contactDiscordUserId,
  }))

  const wanted = rows.filter((r) => r.outcome === 'NEW')

  if (!input.confirm) return plan(rows, false, null)

  if (wanted.length === 0) {
    return plan(rows, false,
      all.length === 0
        ? 'There are no teams yet. Build them from the roster, or import a file of names.'
        : 'Every team already holds a working token. Nothing was issued.')
  }

  const issued = await tx(async (client) => {
    const out: BulkRow[] = []
    for (const row of rows) {
      if (row.outcome !== 'NEW') { out.push(row); continue }
      const token = await issueSubmissionToken({
        label: row.teamName, teamId: row.teamId!, issuedBy: input.actor, client,
      })
      out.push({ ...row, token: token.token, tokenId: token.tokenId })
    }
    return out
  })

  await recordAudit({
    actor: input.actor, action: 'submissions.tokens_bulk_issued',
    subjectType: 'access_token', subjectId: 'teams-without',
    payload: {
      issued: wanted.length,
      skipped: rows.length - wanted.length,
      teamIds: wanted.map((r) => r.teamId),
    },
  })
  log.info('tokens issued for teams without one', {
    issued: wanted.length, actor: input.actor,
  })

  return plan(issued, true, null)
}
