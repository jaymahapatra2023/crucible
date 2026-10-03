import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { DiscoveryTiles } from '../components/DiscoveryTiles.js'
import { DiscoverySection } from '../components/DiscoverySection.js'
import { DiscoveryConflicts } from '../components/DiscoveryConflicts.js'
import { DiscoveryGaps, DiscoveryRuntime } from '../components/DiscoveryGaps.js'
import { DiscoveryChanges } from '../components/DiscoveryChanges.js'
import {
  FINDING_KINDS, KIND_TITLES, dismissFinding, getDiscovery, reinstateFinding, runDiscovery,
  type Discovery,
} from '../lib/discoveryApi.js'

/** Which tile maps to which findings section, so clicking a tile opens the right one. */
const TILE_TO_KIND: Record<string, string> = {
  endpoints: 'ENDPOINT', entities: 'ENTITY', capabilities: 'CAPABILITY',
  integrations: 'INTEGRATION', security: 'SECURITY', stack: 'STACK',
}

/**
 * What a submission IS (E12).
 *
 * Deliberately separate from its scores. This page answers "what did this team build" — the API
 * surface, the data model, the capabilities, the stack, what it talks to and what a security
 * reviewer would want to look at. A reviewer reads it BEFORE they read a score, so the score
 * lands against a picture of the work rather than the other way round.
 *
 * Every number on it is a count of rows a reviewer can scroll to and check, and a concern that
 * could not be read says so instead of showing a zero.
 */
export function DiscoveryPage() {
  const { submissionId = '' } = useParams()
  const [selected, setSelected] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const { state, reload } = useAsyncData<Discovery>(() => getDiscovery(submissionId), [submissionId])

  /** Run a reviewer action, then reload so the tile's warning reflects what is left to check. */
  async function act(what: () => Promise<unknown>) {
    setRunning(true)
    setFailure(null)
    try {
      await what()
      reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be recorded.')
    } finally {
      setRunning(false)
    }
  }

  async function start() {
    setRunning(true)
    setFailure(null)
    try {
      await runDiscovery(submissionId)
      reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Discovery could not be started.')
    } finally {
      setRunning(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading discovery" />

  if (state.status === 'error') {
    if (state.error.status === 404) {
      return <NotDiscovered onStart={start} running={running} failure={failure} />
    }
    return (
      <ErrorState title="Discovery could not be loaded" message={state.error.message}
        detail={state.error.code} onRetry={reload} />
    )
  }

  const d = state.data
  const selectedKind = selected === null ? null : TILE_TO_KIND[selected] ?? null

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>What this team built</h1>
        <span style={{ color: 'var(--text-muted)' }}>
          Submission {submissionId}
          {d.commitSha && <> · commit <code>{d.commitSha.slice(0, 10)}</code></>}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" onClick={start} disabled={running}>
            {running ? 'Running…' : 'Re-run discovery'}
          </button>
        </span>
      </header>

      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        A description, not a score. Nothing here ranks this submission against another — it is
        what the code was found to contain, with the file and line for each claim so you can
        check it.
        {d.model && <> Read by {d.model}{d.costUsd > 0 && ` · $${d.costUsd.toFixed(4)}`}.</>}
      </p>

      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      <DiscoveryTiles
        tiles={d.tiles} selected={selected}
        onSelect={(key) => setSelected((prev) => (prev === key ? null : key))}
      />

      <DiscoveryGaps gaps={d.gaps} total={d.tiles.length} />

      <DiscoveryRuntime runtime={d.runtime} />

      {FINDING_KINDS.map((kind) => (
        <DiscoverySection
          key={kind}
          title={KIND_TITLES[kind] ?? kind}
          tile={d.tiles.find((t) => TILE_TO_KIND[t.key] === kind)}
          findings={d.findings[kind] ?? []}
          open={selectedKind === kind}
          busy={running}
          onDismiss={(id, reason) => void act(() => dismissFinding(id, reason))}
          onReinstate={(id) => void act(() => reinstateFinding(id))}
        />
      ))}

      <h2 style={{ fontSize: 15, marginTop: 24 }}>Documentation against code</h2>
      <DiscoveryConflicts conflicts={d.conflicts} />

      <DiscoveryChanges submissionId={submissionId} />
    </section>
  )
}

/** A submission nobody has described yet. Discovery is explicit, so this offers the action. */
function NotDiscovered({
  onStart, running, failure,
}: {
  onStart: () => void
  running: boolean
  failure: string | null
}) {
  return (
    <section>
      <h1 style={{ fontSize: 19 }}>What this team built</h1>
      <EmptyState
        title="This submission has not been described yet"
        explanation={
          'Discovery reads the persisted scan and works out what the submission exposes, '
          + 'stores, does and depends on. It costs about seven model calls and nothing runs it '
          + 'automatically, so start it when you want it.'}
        action={
          <button type="button" onClick={onStart} disabled={running}>
            {running ? 'Running discovery…' : 'Run discovery'}
          </button>}
      />
      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}
    </section>
  )
}
