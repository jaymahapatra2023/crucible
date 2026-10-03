/**
 * The golden set and its seal (E11-S01).
 *
 * The seal is the mechanism behind acceptance 3 — "hand-ranked independently by at least two
 * people BEFORE any machine scoring". Sealing is what permits scoring, and a sealed set accepts
 * no further entries or rankings, so the order of events is a property of the data rather than a
 * rule somebody has to remember.
 *
 * Independence is the other half, and it is enforced by refusing to show one ranker another's
 * positions while the set is open. Not because anyone would deliberately copy, but because
 * having seen a colleague's ordering it is no longer possible to produce an independent one.
 */
import { interRaterAgreement, type RaterAgreement } from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import {
  distinctRankers, insertEntry, insertGoldenSet, insertRanking, listGoldenSets,
  sealGoldenSet, selectEntries, selectGoldenSet, selectRankings,
  type GoldenEntryRow, type GoldenSetRow, type RankingRow,
} from '../db/calibrationDb.js'

const log = createLogger('calibration', 'goldenSet')

/** E11-S01's floors, stated once. */
export const MINIMUM_ENTRIES = 8
export const MINIMUM_RANKERS = 2
export const REQUIRED_EDGE_CASES = [
  'SCAFFOLD_ONLY', 'WRONG_PROBLEM', 'FAILS_TO_BUILD', 'VERY_LARGE',
] as const

export interface Readiness {
  canSeal: boolean
  entries: number
  rankers: string[]
  /** Rankers who have not ranked every entry — an incomplete ordering is not a ranking. */
  incompleteRankers: string[]
  missingEdgeCases: string[]
  missingBands: string[]
  problems: string[]
  /**
   * Things worth knowing before sealing that do not stop it (E33).
   *
   * Separate from `problems` on purpose. Sealing is irreversible and the criteria that judge the
   * report are recorded before it, so turning a judgement about ranker agreement into a refusal
   * would be adding a threshold nobody wrote down. A warning puts it in front of the person
   * taking the irreversible step, which is where it belongs and as far as it should go.
   */
  warnings: string[]
  /** How much the rankers agree with each other, while it can still be acted on. */
  agreement: RaterAgreement | null
}

export async function createGoldenSet(input: {
  name: string; description: string; actor: string
}): Promise<GoldenSetRow> {
  const set = await insertGoldenSet({
    name: input.name, description: input.description, createdBy: input.actor,
  })
  await recordAudit({
    actor: input.actor, action: 'calibration.golden_set_created',
    subjectType: 'golden_set', subjectId: String(set.golden_set_id),
    payload: { name: input.name },
  })
  return set
}

export async function addEntry(input: {
  goldenSetId: number
  label: string
  repoUrl: string
  expectedBand: string
  edgeCase: string | null
  notes: string
  actor: string
}): Promise<GoldenEntryRow> {
  await assertOpen(input.goldenSetId)
  try {
    return await insertEntry(input)
  } catch (err) {
    throw translateSeal(err, input.goldenSetId)
  }
}

/**
 * Record one person's ordering.
 *
 * Refused once the set is sealed, which is the point: a hand ranking submitted after the machine
 * has scored is not evidence about the machine, it is evidence about the ranker.
 */
export async function recordRanking(input: {
  goldenSetId: number
  ranker: string
  positions: ReadonlyArray<{ entryId: number; position: number; rationale?: string }>
  actor: string
}): Promise<void> {
  await assertOpen(input.goldenSetId)

  const entries = await selectEntries(input.goldenSetId)
  const known = new Set(entries.map((e) => e.entry_id))

  for (const p of input.positions) {
    if (!known.has(p.entryId)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Entry ${p.entryId} is not in this golden set.`,
      )
    }
  }

  if (input.positions.length !== entries.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `A ranking must place every one of the ${entries.length} entries; ` +
        `${input.positions.length} were given. A partial ordering cannot be compared against ` +
        `the machine's, which places them all.`,
    )
  }

  try {
    for (const p of input.positions) {
      await insertRanking({
        goldenSetId: input.goldenSetId,
        entryId: p.entryId,
        ranker: input.ranker,
        position: p.position,
        rationale: p.rationale ?? '',
      })
    }
  } catch (err) {
    throw translateSeal(err, input.goldenSetId)
  }

  await recordAudit({
    actor: input.actor, action: 'calibration.ranking_recorded',
    subjectType: 'golden_set', subjectId: String(input.goldenSetId),
    payload: { ranker: input.ranker, entries: input.positions.length },
  })
  log.info('hand ranking recorded', {
    goldenSetId: input.goldenSetId, ranker: input.ranker,
  })
}

/**
 * One ranker's own ordering, or every ordering once the set is sealed.
 *
 * While the set is open a ranker sees only their own. Independence cannot be restored once lost,
 * so it is protected rather than requested.
 */
export async function rankingsFor(
  goldenSetId: number, requester: string,
): Promise<RankingRow[]> {
  const set = await requireSet(goldenSetId)
  if (set.status === 'SEALED') return selectRankings(goldenSetId)
  return selectRankings(goldenSetId, requester)
}

export async function readiness(goldenSetId: number): Promise<Readiness> {
  const [entries, rankers] = await Promise.all([
    selectEntries(goldenSetId),
    distinctRankers(goldenSetId),
  ])

  const problems: string[] = []
  if (entries.length < MINIMUM_ENTRIES) {
    problems.push(
      `${entries.length} of ${MINIMUM_ENTRIES} repositories. Fewer cannot span clearly strong, ` +
      `middling and clearly weak work with edge cases as well.`)
  }
  if (rankers.length < MINIMUM_RANKERS) {
    problems.push(
      `${rankers.length} of ${MINIMUM_RANKERS} hand rankings. One person's ordering cannot be ` +
      `distinguished from that person's preferences.`)
  }

  const bands = new Set(entries.map((e) => e.expected_band))
  const missingBands = ['STRONG', 'MIDDLING', 'WEAK'].filter((b) => !bands.has(b))
  if (missingBands.length > 0) {
    problems.push(
      `No ${missingBands.join(' or ').toLowerCase()} repository. A set that does not span the ` +
      `range cannot show whether the machine separates the range.`)
  }

  const present = new Set(entries.map((e) => e.edge_case).filter(Boolean))
  const missingEdgeCases = REQUIRED_EDGE_CASES.filter((c) => !present.has(c))
  if (missingEdgeCases.length > 0) {
    problems.push(
      `Missing edge case(s): ${missingEdgeCases.join(', ')}. These are the inputs most likely ` +
      `to be scored wrongly, so a set without them tests the easy half.`)
  }

  // A ranker who ordered six of eight has not produced an ordering.
  const byRanker = await Promise.all(
    rankers.map(async (r) => ({ r, rows: await selectRankings(goldenSetId, r) })))
  const incompleteRankers = byRanker
    .filter((x) => x.rows.length !== entries.length)
    .map((x) => x.r)
  if (incompleteRankers.length > 0) {
    problems.push(`Incomplete ranking(s) from: ${incompleteRankers.join(', ')}.`)
  }

  /*
   * Agreement is computed HERE, before sealing, because that is the last moment it can change
   * anything. The calibration report carries the same number, but by then the rankings are
   * frozen and the answer to "these two barely agree" is no longer "have them talk about what
   * the dimension means".
   */
  const agreement = rankers.length === 0 ? null : interRaterAgreement(
    byRanker.flatMap(({ r, rows }) =>
      rows.map((row) => ({ entryId: String(row.entry_id), ranker: r, position: row.position }))))

  const warnings: string[] = []
  if (agreement && agreement.strength !== 'STRONG' && rankers.length >= MINIMUM_RANKERS) {
    warnings.push(agreement.note)
  }
  if (agreement?.independenceQuestioned) {
    warnings.push(agreement.note)
  }

  return {
    canSeal: problems.length === 0,
    entries: entries.length,
    rankers,
    incompleteRankers,
    missingEdgeCases: [...missingEdgeCases],
    missingBands,
    problems,
    warnings,
    agreement,
  }
}

/** Seal the set, permitting machine scoring and freezing the human judgement. */
export async function seal(goldenSetId: number, actor: string): Promise<GoldenSetRow> {
  const state = await readiness(goldenSetId)
  if (!state.canSeal) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `This golden set is not ready to seal. ${state.problems.join(' ')}`,
      { details: { problems: state.problems } },
    )
  }

  const sealed = await sealGoldenSet(goldenSetId, actor)
  if (!sealed) {
    throw new AppError(
      'CONFLICT',
      `Golden set ${goldenSetId} is already sealed. Sealing is irreversible: it is the record ` +
        `that the hand rankings predate the machine's.`,
    )
  }

  await recordAudit({
    actor, action: 'calibration.golden_set_sealed',
    subjectType: 'golden_set', subjectId: String(goldenSetId),
    payload: { entries: state.entries, rankers: state.rankers },
  })
  log.info('golden set sealed', { goldenSetId, ...state })
  return sealed
}

export async function requireSet(goldenSetId: number): Promise<GoldenSetRow> {
  const set = await selectGoldenSet(goldenSetId)
  if (!set) throw new AppError('NOT_FOUND', `Golden set ${goldenSetId} was not found.`)
  return set
}

export const listSets = listGoldenSets
export const entriesFor = selectEntries

async function assertOpen(goldenSetId: number): Promise<void> {
  const set = await requireSet(goldenSetId)
  if (set.status !== 'OPEN') throw sealedError(goldenSetId)
}

function translateSeal(err: unknown, goldenSetId: number): unknown {
  return String(err).includes('is SEALED') ? sealedError(goldenSetId) : err
}

function sealedError(goldenSetId: number): AppError {
  return new AppError(
    'CONFLICT',
    `Golden set ${goldenSetId} is sealed. Its entries and hand rankings are fixed, because ` +
      `sealing is what records that they predate the machine's scoring — a ranking added now ` +
      `would say nothing about the machine.`,
  )
}
