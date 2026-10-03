/**
 * What changed between one discovery and the one it replaced (E16-S04, G8).
 *
 * Re-running supersedes wholesale, which answers "what is true now" and not "what moved". For a
 * one-evening hackathon that is nearly harmless — a submission is discovered once. It matters
 * the moment a team resubmits after fixing something: the reviewer can see that the new run does
 * not list the observation, which is a weaker and more ambiguous statement than seeing that it
 * is GONE.
 *
 * Deterministic: a match on `(kind, label, path)`, no model call. The reference implementation
 * spends a call classifying NEW/UPDATE/DUPLICATE; a join answers the same question for nothing.
 */
import { query } from '../../../db/pool.js'

export interface DiffEntry {
  kind: string
  label: string
  path: string
  summary: string
}

export interface DiscoveryDiff {
  comparable: boolean
  previousDiscoveryId: number | null
  added: DiffEntry[]
  unchanged: number
  disappeared: DiffEntry[]
  /** Disappeared security observations, called out because that is where it matters most. */
  resolvedSecurity: DiffEntry[]
  note: string
}

const identity = (e: { kind: string; label: string; path: string }) =>
  `${e.kind}\u0000${e.label}\u0000${e.path}`

/**
 * Compare the current discovery for a submission against the one it superseded.
 *
 * Computed on demand rather than eagerly: most runs are never compared, and a diff nobody reads
 * is a write nobody needed.
 */
export async function diffLatest(submissionId: number): Promise<DiscoveryDiff> {
  const runs = await query<{ discovery_id: number; superseded_at: Date | null }>(
    `SELECT discovery_id, superseded_at FROM discovery_run
      WHERE submission_id = $1
      ORDER BY superseded_at IS NULL DESC, superseded_at DESC
      LIMIT 2`,
    [submissionId])

  const current = runs.rows[0]
  const previous = runs.rows[1]

  if (!current || !previous) {
    return {
      comparable: false,
      previousDiscoveryId: null,
      added: [], unchanged: 0, disappeared: [], resolvedSecurity: [],
      note: 'This submission has been discovered once, so there is nothing to compare it with.',
    }
  }

  const [now, before] = await Promise.all([
    findingsOf(current.discovery_id),
    findingsOf(previous.discovery_id),
  ])

  const beforeKeys = new Set(before.map(identity))
  const nowKeys = new Set(now.map(identity))

  const added = now.filter((f) => !beforeKeys.has(identity(f)))
  const disappeared = before.filter((f) => !nowKeys.has(identity(f)))

  return {
    comparable: true,
    previousDiscoveryId: Number(previous.discovery_id),
    added,
    unchanged: now.length - added.length,
    disappeared,
    resolvedSecurity: disappeared.filter((f) => f.kind === 'SECURITY'),
    note: describe(added.length, disappeared.length),
  }
}

async function findingsOf(discoveryId: number): Promise<DiffEntry[]> {
  const res = await query<DiffEntry>(
    `SELECT kind, label, path, summary FROM discovery_finding WHERE discovery_id = $1`,
    [discoveryId])
  return res.rows
}

function describe(added: number, disappeared: number): string {
  if (added === 0 && disappeared === 0) {
    return 'This re-run found exactly what the previous one did.'
  }

  const parts: string[] = []
  if (added > 0) parts.push(`${added} finding${added === 1 ? '' : 's'} appeared`)
  if (disappeared > 0) {
    // "Gone" is the honest word, and the caveat matters: a finding can vanish because the code
    // changed, or because this run read different files. Only a reviewer can tell which.
    parts.push(`${disappeared} ${disappeared === 1 ? 'is' : 'are'} no longer reported`)
  }
  return `${parts.join(' and ')}. A finding that is no longer reported may have been fixed, or `
    + `may simply not have been read this time — the two look identical from here.`
}
