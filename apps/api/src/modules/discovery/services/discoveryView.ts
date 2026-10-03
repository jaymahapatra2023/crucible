/**
 * The shape the discovery UI reads (E12, E08-S06).
 *
 * Assembled on the server so the honesty rules live in one place. The central one: a tile shows
 * a NUMBER only where a number is a true statement about the submission. Where the extractor
 * could not read enough, or failed, the tile shows that state instead — never a zero.
 *
 * A zero and an unknown look identical on a dashboard and mean opposite things. "0 integrations"
 * says this team built something self-contained. "Integrations: not determined" says we did not
 * manage to look. A reviewer who cannot tell them apart will read the second as the first.
 */
import {
  conflictsFor, currentDiscovery, findingCounts, findingsFor, openFindingCounts,
} from '../db/discoveryDb.js'
import { CONCERNS, type ConcernOutcome, type ConcernResult } from './discoveryConcerns.js'

export interface DiscoveryTile {
  key: string
  label: string
  /** The count, or null where a count would be a false statement. */
  count: number | null
  outcome: ConcernOutcome
  /** True when this tile should draw attention: a failure, a gap, or something flagged. */
  warn: boolean
  note: string
}

export interface DiscoveryView {
  status: 'ABSENT' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  discoveryId: number | null
  commitSha: string | null
  scanId: number | null
  model: string | null
  costUsd: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  tiles: DiscoveryTile[]
  findings: Record<string, unknown[]>
  conflicts: unknown[]
  /** Concerns that produced nothing usable, named so the UI can say what is missing. */
  gaps: Array<{ key: string; label: string; outcome: ConcernOutcome; note: string }>
  runtime: { containerised: boolean; entrypoint: string; notes: string } | null
}

const TILE_LABELS: Record<string, string> = {
  endpoints: 'API endpoints',
  entities: 'Data entities',
  capabilities: 'Capabilities',
  integrations: 'Integrations',
  security: 'Security observations',
  stack: 'Stack components',
  claims: 'Claim conflicts',
}

export async function discoveryView(submissionId: number): Promise<DiscoveryView> {
  const run = await currentDiscovery(submissionId)

  if (!run) {
    return {
      status: 'ABSENT', discoveryId: null, commitSha: null, scanId: null, model: null,
      costUsd: 0, startedAt: null, finishedAt: null, error: null,
      tiles: [], findings: {}, conflicts: [], gaps: [], runtime: null,
    }
  }

  const [findings, conflicts, counts, open] = await Promise.all([
    findingsFor(submissionId), conflictsFor(submissionId),
    findingCounts(submissionId), openFindingCounts(submissionId),
  ])

  const tiles = buildTiles(
    run.concerns as Record<string, ConcernResult | undefined>,
    counts, conflicts.length, open)

  return {
    status: run.status as DiscoveryView['status'],
    discoveryId: Number(run.discovery_id),
    commitSha: run.commit_sha,
    scanId: Number(run.scan_id),
    model: run.model,
    costUsd: Number(run.cost_usd),
    startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null,
    error: run.error,
    tiles,
    findings: groupByKind(findings),
    conflicts,
    gaps: tiles
      .filter((t) => t.outcome === 'INSUFFICIENT_EVIDENCE' || t.outcome === 'FAILED')
      .map((t) => ({ key: t.key, label: t.label, outcome: t.outcome, note: t.note })),
    runtime: runtimeOf(findings),
  }
}

/**
 * The tile strip, from the outcomes the run recorded and the rows that actually exist.
 *
 * Pure, and separated from the query for that reason: this is where "a gap is not a zero" is
 * either upheld or quietly lost, and it should be provable without a database.
 */
export function buildTiles(
  concerns: Record<string, ConcernResult | undefined>,
  counts: Record<string, number>,
  conflictCount: number,
  /** Findings still awaiting a look, per kind. Absent means none have been reviewed yet. */
  open: Record<string, number> = counts,
): DiscoveryTile[] {
  return CONCERNS.map((c) => {
    const recorded = concerns[c.key]
    const outcome: ConcernOutcome = recorded?.outcome ?? 'FAILED'
    const live = c.kind ? (counts[c.kind] ?? 0) : conflictCount
    return {
      key: c.key,
      label: TILE_LABELS[c.key] ?? c.key,
      // Counted from the rows that exist, not from what the extractor claimed it returned: the
      // cap on findings per kind means the two can legitimately differ, and the number on
      // screen must match the list underneath it.
      count: outcome === 'FOUND' || outcome === 'NONE_FOUND' ? live : null,
      outcome,
      // Warned on what is still OPEN, not on what was found. The count stays — a reviewer
      // checking an observation does not make it stop having existed — but the amber does not,
      // because there is nothing left to look at.
      // `?? 0`, not `?? live`: a kind missing from the open counts means every one of its
      // findings has been checked, which is precisely the case that should stop warning.
      warn: warnFor(c.key, outcome, c.kind ? (open[c.kind] ?? 0) : conflictCount),
      note: recorded?.note ?? 'This concern was not recorded on the run.',
    }
  })
}

/**
 * When a tile should draw the eye.
 *
 * Three cases, and only three. A concern that could not be read (the reviewer needs to know the
 * page is incomplete); a security observation or claim conflict that exists (the reviewer needs
 * to look at it); and nothing else. Notably NOT: a low count. A submission with two endpoints
 * has not done anything wrong, and colouring its tile red would turn a description into a
 * judgement the evidence does not support.
 */
function warnFor(key: string, outcome: ConcernOutcome, count: number): boolean {
  if (outcome === 'FAILED' || outcome === 'INSUFFICIENT_EVIDENCE') return true
  return (key === 'security' || key === 'claims') && count > 0
}

function groupByKind(findings: Array<{ kind: string }>): Record<string, unknown[]> {
  const grouped: Record<string, unknown[]> = {}
  for (const f of findings) (grouped[f.kind] ??= []).push(f)
  return grouped
}

/** The runtime facts the stack extractor attached to every component it found. */
function runtimeOf(
  findings: Array<{ kind: string; detail: Record<string, unknown> }>,
): DiscoveryView['runtime'] {
  const stack = findings.find((f) => f.kind === 'STACK' && f.detail['runtime'])
  const runtime = stack?.detail['runtime'] as DiscoveryView['runtime'] | undefined
  return runtime ?? null
}
