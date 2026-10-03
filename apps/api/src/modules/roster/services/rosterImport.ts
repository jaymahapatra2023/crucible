/**
 * Loading the three lists from a file (E27-S01, E27-S02).
 *
 * The same shape E20 established for bulk token issue, because an operator should not have to
 * learn two import behaviours: **the plan is computed and returned first, nothing is written, and
 * a file with any unusable row is refused whole.** Importing the good rows would leave somebody
 * reconciling which of 200 people exist against a file that does not say.
 *
 * One deliberate difference from tokens: a row naming somebody who already exists is reported as
 * `EXISTING` and is not an error. Re-uploading a corrected list is the normal way this gets used,
 * and treating the second upload as 200 conflicts would make correction impossible.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { tx } from '../../../db/pool.js'
import { CsvError, headerIndex, parseCsv } from '../../../lib/csv.js'
import { teams } from '../../../lib/ports/teamPort.js'
import {
  insertCoach, insertParticipant, selectCoachByEmail, selectParticipantByEmail,
} from '../db/rosterDb.js'
import { insertRoom, selectRoomByLabel } from '../db/roomDb.js'
import { assign } from './membershipService.js'

const log = createLogger('roster', 'import')

export const ROSTER_KINDS = ['participant', 'room', 'coach'] as const
export type RosterKind = (typeof ROSTER_KINDS)[number]

export const IMPORT_OUTCOMES = ['NEW', 'EXISTING', 'INVALID', 'DUPLICATE'] as const
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number]

export interface ImportRow {
  line: number
  /** What the row names, for the operator to recognise: a person's name, or a room's label. */
  label: string
  detail: string | null
  outcome: ImportOutcome
  /** Set once written, or when the row matched something that already exists. */
  id: number | null
  /** The team this row would join, where it named one (E28-S03). */
  teamName: string | null
  /** Whether that team would have to be created. Stated before anything is written. */
  teamIsNew: boolean
}

export interface ImportPlan {
  kind: RosterKind
  rows: ImportRow[]
  summary: Record<Lowercase<ImportOutcome>, number> & { total: number }
  imported: boolean
  refusal: string | null
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const COLUMNS = {
  participant: {
    full_name: ['full_name', 'name', 'participant', 'full name'],
    email: ['email', 'e-mail', 'address'],
  },
  room: {
    label: ['label', 'room', 'name', 'room_name'],
  },
  coach: {
    full_name: ['full_name', 'name', 'coach'],
    email: ['email', 'e-mail'],
  },
} as const

/**
 * Optional columns, looked up by name and simply absent when not present.
 *
 * `team_name` is the one that does more than record a value: a participant row carrying it is
 * assigned in the same pass, creating the team if it does not exist (E28-S03). Most registration
 * exports already have a team column, and re-typing 200 assignments that were already stated
 * would be the slowest possible way to use them.
 */
const OPTIONAL = [
  'organisation', 'phone', 'notes', 'location', 'capacity', 'team_capacity', 'teams',
  'team_name', 'discord',
] as const

const MAX_ROWS = 1000

export async function importRoster(input: {
  kind: RosterKind
  csv: string
  confirm: boolean
  actor: string
}): Promise<ImportPlan> {
  const parsed = readFile(input.kind, input.csv)
  const rows = await plan(input.kind, parsed)
  const unusable = rows.filter((r) => r.outcome === 'INVALID' || r.outcome === 'DUPLICATE')

  if (!input.confirm) return summarise(input.kind, rows, false, null)

  if (unusable.length > 0) {
    return summarise(input.kind, rows, false,
      `Nothing was imported. ${unusable.length} of ${rows.length} rows cannot be acted on — `
      + `fix them and upload the file again.`)
  }

  const written = await tx(async (client) => {
    const out: ImportRow[] = []
    for (const [i, row] of rows.entries()) {
      if (row.outcome !== 'NEW') { out.push(row); continue }
      const id = await write(input.kind, parsed[i]!, input.actor, client)
      out.push({ ...row, id, outcome: 'NEW' })
    }
    return out
  })

  // Assignment happens AFTER the transaction that created the people, not inside it. Creating a
  // team goes through the team port into another module's table, and enlisting that in this
  // module's transaction is exactly the coupling ADR 0002 exists to avoid. The cost is that a
  // failure here leaves participants imported and unassigned — which is a visible, recoverable
  // state the assignment surface already exists to work through.
  const assigned = await assignFromFile(written, parsed, input.actor)

  const created = written.filter((r) => r.outcome === 'NEW').length
  await recordAudit({
    actor: input.actor, action: `roster.${input.kind}s_imported`,
    subjectType: input.kind, subjectId: 'bulk',
    // Counts and ids. A participant's address is personal data and does not belong in a payload
    // that every reader of the audit trail can see (P8.3).
    payload: { created, existing: written.length - created },
  })
  log.info('roster imported', { kind: input.kind, created, actor: input.actor })

  return summarise(input.kind, assigned, true, null)
}

/**
 * Put each imported participant on the team their row named.
 *
 * Teams are matched through the port, which compares by the owning module's own normalisation —
 * so a spreadsheet carrying "The Night Shift" and "night shift" produces one team rather than two
 * (E28-S03 acceptance 2).
 */
async function assignFromFile(
  rows: readonly ImportRow[], parsed: readonly ParsedRow[], actor: string,
): Promise<ImportRow[]> {
  const out: ImportRow[] = []

  for (const [i, row] of rows.entries()) {
    const wanted = row.teamName
    if (wanted === null || row.id === null) { out.push(row); continue }

    const found = await teams().findByName(wanted)
    const team = found ?? await teams().create({
      displayName: wanted,
      contactEmail: parsed[i]!.values['email'] ?? '',
      actor,
    })

    try {
      await assign({ teamId: team.teamId, participantId: row.id, actor })
      out.push({ ...row, teamName: team.displayName, teamIsNew: found === null })
    } catch (err) {
      // Reported against the row rather than failing the import. The people are real and
      // imported; an assignment that could not be made is a line on a worklist.
      out.push({
        ...row, teamName: team.displayName,
        detail: `Imported, but not assigned to ${team.displayName}: `
          + `${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return out
}

interface ParsedRow {
  line: number
  values: Record<string, string>
}

function readFile(kind: RosterKind, csv: string): ParsedRow[] {
  if (csv.trim() === '') {
    throw new AppError('VALIDATION_FAILED',
      `That file is empty. It needs a header naming ${Object.keys(COLUMNS[kind]).join(' and ')}, `
      + `then one row each.`)
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

  const header = records[0]?.cells ?? []
  let required: Record<string, number>
  try {
    required = headerIndex(header, COLUMNS[kind])
  } catch (err) {
    if (err instanceof CsvError) throw new AppError('VALIDATION_FAILED', err.message)
    throw err
  }

  const body = records.slice(1)
  if (body.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'That file has a header and nothing under it.')
  }
  if (body.length > MAX_ROWS) {
    throw new AppError('VALIDATION_FAILED',
      `That file has ${body.length} rows and at most ${MAX_ROWS} may be imported at once.`)
  }

  // Both sides through the same normalisation. Comparing a normalised header against a raw name
  // meant `team_name` never matched `teamname` — and only that column has an underscore, which is
  // why nothing else revealed it.
  const flatten = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, '')
  const normalised = header.map(flatten)
  const optional = new Map(OPTIONAL.map((name) => [name, normalised.indexOf(flatten(name))]))

  return body.map((record) => {
    const cell = (i: number) => (i < 0 ? '' : (record.cells[i] ?? '').trim())
    const values: Record<string, string> = {}
    for (const [name, index] of Object.entries(required)) values[name] = cell(index)
    for (const [name, index] of optional) values[name] = cell(index)
    return { line: record.line, values }
  })
}

/** Decide each row against what is already stored, and against the rest of the file. */
async function plan(kind: RosterKind, parsed: readonly ParsedRow[]): Promise<ImportRow[]> {
  const seen = new Map<string, number>()
  const rows: ImportRow[] = []

  for (const row of parsed) {
    const key = kind === 'room' ? row.values['label']! : row.values['email']!
    const label = kind === 'room' ? row.values['label']! : row.values['full_name']!
    const wantedTeam = kind === 'participant' ? (row.values['team_name'] ?? '') : ''
    const base = {
      line: row.line, label, id: null as number | null,
      teamName: wantedTeam === '' ? null : wantedTeam,
      teamIsNew: false,
    }

    const problem = problemWith(kind, row.values)
    if (problem) { rows.push({ ...base, outcome: 'INVALID', detail: problem }); continue }

    const earlier = seen.get(key.toLowerCase())
    if (earlier !== undefined) {
      rows.push({
        ...base, outcome: 'DUPLICATE',
        detail: `The same ${kind === 'room' ? 'room' : 'address'} appears on line ${earlier}.`,
      })
      continue
    }
    seen.set(key.toLowerCase(), row.line)

    // Whether the named team exists is part of the plan: "would create 7 teams" is something an
    // operator should see before it happens, not discover afterwards.
    if (base.teamName !== null) {
      base.teamIsNew = (await teams().findByName(base.teamName)) === null
    }

    const existing = await findExisting(kind, key)
    rows.push(existing === null
      ? { ...base, outcome: 'NEW', detail: null }
      : {
        ...base, outcome: 'EXISTING', id: existing,
        detail: 'Already on the list. Nothing about them is changed by importing again — edit '
          + 'them directly to correct anything.',
      })
  }

  return rows
}

function problemWith(kind: RosterKind, v: Record<string, string>): string | null {
  if (kind === 'room') return problemWithRoom(v)

  const name = v['full_name'] ?? ''
  if (name.trim().length < 2) return 'The name is missing, or too short to be one.'
  const email = v['email'] ?? ''
  if (email === '') return 'The email address is missing. It is how this person is identified.'
  if (!EMAIL.test(email)) return `"${email}" is not an email address.`

  if (kind === 'coach') {
    // A coach's team count is read the same way a room's is (migration 102), so a typo in it
    // is caught here rather than becoming a coach with no teams.
    const teamCapacity = teamCapacityOf(v)
    if (teamCapacity !== '' && !(Number.isInteger(Number(teamCapacity)) && Number(teamCapacity) > 0)) {
      return `"${teamCapacity}" is not a number of teams.`
    }
  }
  return null
}

async function findExisting(kind: RosterKind, key: string): Promise<number | null> {
  if (kind === 'room') return (await selectRoomByLabel(key))?.roomId ?? null
  if (kind === 'coach') return (await selectCoachByEmail(key))?.coachId ?? null
  return (await selectParticipantByEmail(key))?.participantId ?? null
}

async function write(
  kind: RosterKind, row: ParsedRow, actor: string, client: Parameters<typeof insertRoom>[1],
): Promise<number> {
  const v = row.values
  const blank = (s: string | undefined) => (s === undefined || s === '' ? null : s)

  if (kind === 'room') {
    const capacity = v['capacity'] ?? ''
    const teamCapacity = teamCapacityOf(v)
    return (await insertRoom({
      label: v['label']!, location: v['location'] ?? '',
      capacity: capacity === '' ? null : Number(capacity),
      teamCapacity: teamCapacity === '' ? null : Number(teamCapacity),
      createdBy: actor,
    }, client)).roomId
  }
  if (kind === 'coach') {
    // The number of teams this coach agreed to take (migration 102), under either spelling.
    const teamCapacity = teamCapacityOf(v)
    return (await insertCoach({
      fullName: v['full_name']!, email: v['email']!,
      organisation: blank(v['organisation']),
      teamCapacity: teamCapacity === '' ? null : Number(teamCapacity),
      createdBy: actor,
    }, client)).coachId
  }
  // A Discord username from the file is stored as given (E49-S02 acceptance 3); it is resolved
  // to an id — the thing a DM needs — through the People tab or at registration, where the
  // person can be told the result. An import that silently dropped an unresolvable name would
  // hide the one fact the organiser needs.
  return (await insertParticipant({
    fullName: v['full_name']!, email: v['email']!,
    organisation: blank(v['organisation']), phone: blank(v['phone']),
    notes: v['notes'] ?? '', createdBy: actor,
    discordUsername: blank(v['discord']),
  }, client)).participantId
}

function summarise(
  kind: RosterKind, rows: ImportRow[], imported: boolean, refusal: string | null,
): ImportPlan {
  const count = (o: ImportOutcome) => rows.filter((r) => r.outcome === o).length
  return {
    kind,
    rows,
    summary: {
      total: rows.length, new: count('NEW'), existing: count('EXISTING'),
      invalid: count('INVALID'), duplicate: count('DUPLICATE'),
    },
    imported,
    refusal,
  }
}

/**
 * The TEAM count from a row, under either spelling. Used by rooms and by coaches.
 *
 * `teams` is what a venue plan and a volunteer register call the column; `team_capacity` is what
 * the database calls it. Accepting both means an organiser does not have to rename a column to
 * load their own file, which is the whole reason this importer takes synonyms at all.
 */
function teamCapacityOf(v: Record<string, string>): string {
  // First NON-EMPTY, not first defined. Every optional column is present as '' whether the file
  // had it or not, so `??` would stop at the blank `team_capacity` and never read `teams`.
  for (const key of ['team_capacity', 'teams']) {
    const value = (v[key] ?? '').trim()
    if (value !== '') return value
  }
  return ''
}

/**
 * Why a room row cannot be used.
 *
 * Its own function so that each limit names ITSELF in the message. A file with the two columns
 * swapped is the obvious mistake, and "not a number" would not say which one to go and look at.
 */
function problemWithRoom(v: Record<string, string>): string | null {
  if ((v['label'] ?? '') === '') return 'The room has no label.'

  const positiveInteger = (s: string) => Number.isInteger(Number(s)) && Number(s) > 0

  const capacity = v['capacity'] ?? ''
  if (capacity !== '' && !positiveInteger(capacity)) {
    return `"${capacity}" is not a number of people.`
  }
  const teamCapacity = teamCapacityOf(v)
  if (teamCapacity !== '' && !positiveInteger(teamCapacity)) {
    return `"${teamCapacity}" is not a number of teams.`
  }
  return null
}
