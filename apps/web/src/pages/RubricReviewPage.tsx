import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DIMENSIONS, DIMENSION_LABELS, approveRubric, freezeRubric, getReadiness, getRubric,
  createRubricVersion, publishRubric, removeCriterion, setCriterionWeights, setDimensionWeights,
  updateCriterion,
  type Dimension, type Readiness, type Rubric,
} from '../lib/rubricApi.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { CriterionCard } from '../components/CriterionCard.js'
import { CriterionEditor } from '../components/CriterionEditor.js'
import { WeightEditor } from '../components/WeightEditor.js'
import { DimensionWeights } from '../components/DimensionWeights.js'
import { ApprovalPanel } from '../components/ApprovalPanel.js'

/** Rubric review, weighting and approval (E02-S06). */
export function RubricReviewPage() {
  const { rubricId = '' } = useParams()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  /** Which criterion is open for editing, if any. One at a time, so weights stay legible. */
  const [editing, setEditing] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(
    async (): Promise<{ rubric: Rubric; readiness: Readiness }> => {
      const [rubric, readiness] = await Promise.all([getRubric(rubricId), getReadiness(rubricId)])
      return { rubric, readiness }
    },
    [rubricId],
  )
  const { state, reload } = useAsyncData(load, [rubricId])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The action failed.')
    } finally {
      setBusy(false)
    }
  }

  /** Start a new draft from this version and go straight to it — there is nothing to do here. */
  async function newVersion() {
    setBusy(true)
    setActionError(null)
    try {
      const draft = await createRubricVersion(
        (state.status === 'ready' ? state.data.rubric.challengeId : ''), rubricId)
      navigate(`/rubrics/${draft.rubricId}`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'A new version could not be created.')
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading rubric" />
  if (state.status === 'error') {
    return <ErrorState title="Rubric could not be loaded" message={state.error.message} onRetry={reload} />
  }

  const { rubric, readiness } = state.data
  const editable = rubric.status === 'DRAFT' || rubric.status === 'IN_REVIEW'

  return (
    <section>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 19, marginBottom: 4 }}>
          Rubric v{rubric.version}{' '}
          <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>
            {rubric.status}
          </span>
        </h1>
        {rubric.contentHash && (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
            Content hash <code>{rubric.contentHash.slice(0, 16)}…</code>
          </p>
        )}
        {!editable && (
          <p style={{ color: 'var(--text-muted)' }}>
            This version is {rubric.status.toLowerCase()} and cannot be edited — teams were shown
            it, so it stays as it was.{' '}
            <button type="button" disabled={busy} onClick={() => void newVersion()}>
              Create a new version from this one
            </button>{' '}
            {/* Carrying the criteria forward, because a committee adjusting one weight should
                not have to retype seven criteria — and a retyped rubric is a different rubric. */}
            <span>
              Its criteria and weights are copied across, ready to edit.
            </span>
          </p>
        )}
      </header>

      {actionError && (
        <div style={{ marginBottom: 16 }}>
          <ErrorState title="That action was refused" message={actionError} />
        </div>
      )}

      <ApprovalPanel
        readiness={readiness}
        status={rubric.status}
        busy={busy}
        onApprove={(acknowledged) => void run(() => approveRubric(rubricId, acknowledged))}
        onFreeze={() => void run(() => freezeRubric(rubricId))}
        onPublish={() => void run(() => publishRubric(rubricId))}
      />

      <DimensionWeights
        weights={rubric.dimensionWeights}
        disabled={!editable || busy}
        onSave={async (weights) => {
          await run(() => setDimensionWeights(rubricId, weights))
        }}
      />

      {rubric.criteria.length === 0 ? (
        <EmptyState
          title="No criteria yet"
          explanation="Generate criteria from the challenge brief, or add them by hand."
        />
      ) : (
        DIMENSIONS.map((dimension: Dimension) => {
          const criteria = rubric.criteria.filter((c) => c.dimension === dimension)
          if (criteria.length === 0) return null
          return (
            <section key={dimension} style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 16, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
                {DIMENSION_LABELS[dimension]}{' '}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 13 }}>
                  {(rubric.dimensionWeights[dimension] * 100).toFixed(0)}% of the composite
                </span>
              </h2>
              {criteria.map((c) => (
                editing === c.criterionId ? (
                  <CriterionEditor
                    key={c.criterionId} criterion={c} busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(edit) => void run(async () => {
                      await updateCriterion(rubricId, c.criterionId, edit)
                      setEditing(null)
                    })}
                    onRemove={() => void run(async () => {
                      await removeCriterion(rubricId, c.criterionId)
                      setEditing(null)
                    })}
                  />
                ) : (
                  <div key={c.criterionId}>
                    <CriterionCard criterion={c} challengeId={rubric.challengeId} />
                    {editable && (
                      <p style={{ margin: '-6px 0 12px' }}>
                        <button type="button" disabled={busy}
                          onClick={() => setEditing(c.criterionId)}>
                          {c.needsRewrite === true ? 'Rewrite this criterion' : 'Edit'}
                        </button>
                      </p>
                    )}
                  </div>
                )
              ))}
              <WeightEditor
                dimension={dimension}
                criteria={rubric.criteria}
                disabled={!editable || busy}
                onSave={async (weights) => {
                  await run(() => setCriterionWeights(rubricId, dimension, weights))
                }}
              />
            </section>
          )
        })
      )}
    </section>
  )
}
