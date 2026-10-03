import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { ArtifactList, NewChallengeForm, RubricList } from '../components/ChallengeSetup.js'
import {
  createChallenge, extractChallenge, generateRubric, listArtifacts, listChallenges,
  listRubrics, uploadArtifact,
  type Artifact, type Challenge, type RubricSummary,
} from '../lib/challengeApi.js'

interface Detail {
  artifacts: Artifact[]
  rubrics: RubricSummary[]
}

/**
 * Setting up a challenge (E02).
 *
 * The order on this page is the order the work has to happen in, and the page says so rather
 * than leaving an organiser to discover it: create the challenge, upload the brief, extract its
 * text, then generate a rubric from what was extracted.
 *
 * Skipping the extraction step is the failure worth preventing. A rubric generated from a brief
 * whose text could not be read is a rubric of criteria that cite passages nobody can open — and
 * it looks perfectly normal until someone follows a citation.
 */
export function ChallengesPage() {
  const [selected, setSelected] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const list = useAsyncData<Challenge[]>(() => listChallenges(), [reloadKey])

  /**
   * The current rubric per challenge, for the one-click link on each row.
   *
   * Fetched for the whole list rather than only the open challenge: the rubric is what an
   * organiser returns to most often, and making it a three-click path through "Set up" buries
   * the thing they came for.
   */
  const rubricLinks = useAsyncData<Record<number, RubricSummary | undefined>>(
    async () => {
      if (list.state.status !== 'ready') return {}
      const entries = await Promise.all(list.state.data.map(async (c) => {
        const rubrics = await listRubrics(c.challengeId).catch(() => [] as RubricSummary[])
        return [c.challengeId, currentRubric(rubrics)] as const
      }))
      return Object.fromEntries(entries)
    },
    [list.state.status, reloadKey],
  )
  const detail = useAsyncData<Detail | null>(
    async () => selected === null ? null : {
      artifacts: await listArtifacts(selected),
      rubrics: await listRubrics(selected),
    },
    [selected, reloadKey],
  )

  async function act(what: () => Promise<string>) {
    setBusy(true)
    setFailure(null)
    try {
      setNotice(await what())
      setReloadKey((n) => n + 1)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
    }
  }

  if (list.state.status === 'loading') return <LoadingState label="Loading challenges" />
  if (list.state.status === 'error') {
    return (
      <ErrorState title="Challenges could not be loaded" message={list.state.error.message}
        detail={list.state.error.code} onRetry={list.reload} />
    )
  }

  const challenges = list.state.data
  const current = challenges.find((c) => c.challengeId === selected) ?? null

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Challenges</h1>
        <span style={{ color: 'var(--text-muted)' }}>
          Upload the brief, extract its text, generate a rubric from what it says.
        </span>
        <button type="button" style={{ marginLeft: 'auto' }} disabled={busy}
          onClick={() => setCreating(true)}>
          New challenge
        </button>
      </header>

      {notice && <p role="status" style={{ color: 'var(--ok)' }}>{notice}</p>}
      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {creating && (
        <NewChallengeForm busy={busy} onCancel={() => setCreating(false)}
          onCreate={(input) => act(async () => {
            const made = await createChallenge(input)
            setCreating(false)
            setSelected(made.challengeId)
            return `${made.name} was created. Upload its brief next.`
          })} />
      )}

      {challenges.length === 0 && !creating ? (
        <EmptyState
          title="No challenges yet"
          explanation="A challenge holds the brief teams are answering and the rubric they are judged by."
          action={<button type="button" onClick={() => setCreating(true)}>New challenge</button>}
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Challenge</th><th scope="col">Status</th>
              <th scope="col">Rubric</th><th scope="col" />
            </tr>
          </thead>
          <tbody>
            {challenges.map((c) => (
              <tr key={c.challengeId}
                style={{ background: c.challengeId === selected ? 'var(--surface)' : undefined }}>
                <td>
                  <strong>{c.name}</strong>
                  {c.description && (
                    <div style={{ color: 'var(--text-muted)' }}>{c.description}</div>
                  )}
                </td>
                <td>{c.status}</td>
                <td>
                  <RubricLink
                    rubric={rubricLinks.state.status === 'ready'
                      ? rubricLinks.state.data[c.challengeId]
                      : undefined} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button"
                    onClick={() => setSelected(
                      c.challengeId === selected ? null : c.challengeId)}>
                    {c.challengeId === selected ? 'Close' : 'Set up'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {current && (
        <SetupPanel
          challenge={current} busy={busy}
          detail={detail.state.status === 'ready' ? detail.state.data : null}
          onUpload={(file) => act(async () => {
            const a = await uploadArtifact(current.challengeId, file)
            return `${a.filename} was uploaded. Extract its text next.`
          })}
          onExtract={() => act(async () => {
            const r = await extractChallenge(current.challengeId)
            return r.failed > 0
              ? `${r.extracted} extracted, ${r.failed} could not be read. A rubric generated now `
                + `would be drawn only from the documents that worked.`
              : `${r.extracted} document${r.extracted === 1 ? '' : 's'} extracted.`
          })}
          onGenerate={() => act(async () => {
            const r = await generateRubric(current.challengeId)
            return r.needsRewrite > 0
              ? `${r.generated} criteria generated; ${r.needsRewrite} were flagged as not yet `
                + `scoreable. Review them before freezing the rubric.`
              : `${r.generated} criteria generated. Review them before freezing the rubric.`
          })}
        />
      )}
    </section>
  )
}

function SetupPanel({
  challenge, detail, busy, onUpload, onExtract, onGenerate,
}: {
  challenge: Challenge
  detail: Detail | null
  busy: boolean
  onUpload: (file: File) => void
  onExtract: () => void
  onGenerate: () => void
}) {
  const extracted = detail?.artifacts.some((a) => a.extractionStatus === 'EXTRACTED') ?? false

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginTop: 16,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>{challenge.name}</h2>

      <h3 style={{ fontSize: 14 }}>1 · Brief and supporting documents</h3>
      <p>
        <input type="file" aria-label="Brief to upload" disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUpload(file)
            e.target.value = ''
          }} />
      </p>
      <ArtifactList artifacts={detail?.artifacts ?? []} />

      <h3 style={{ fontSize: 14, marginTop: 20 }}>2 · Extract the text</h3>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Criteria cite passages of the brief by location. Until the text is extracted there is
        nothing for them to cite.
      </p>
      <button type="button" onClick={onExtract}
        disabled={busy || (detail?.artifacts.length ?? 0) === 0}>
        Extract text
      </button>

      <h3 style={{ fontSize: 14, marginTop: 20 }}>3 · Generate a rubric</h3>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Criteria are drafted from the brief and then reviewed. Nothing is scored against a rubric
        until a person approves and freezes it.
      </p>
      <button type="button" onClick={onGenerate} disabled={busy || !extracted}>
        Generate rubric
      </button>
      {!extracted && (
        <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
          Available once at least one document's text has been extracted.
        </span>
      )}

      <h3 style={{ fontSize: 14, marginTop: 20 }}>Rubrics</h3>
      <RubricList rubrics={detail?.rubrics ?? []} />
    </div>
  )
}

/**
 * The version an organiser means when they say "the rubric".
 *
 * The published one if there is one, else the frozen one, else the newest draft. Teams are
 * judged by what was published, so that is what a link labelled "rubric" must lead to — showing
 * a later draft would point at a standard nobody was told about.
 */
function currentRubric(rubrics: RubricSummary[]): RubricSummary | undefined {
  return rubrics.find((r) => r.publishedAt !== null)
    ?? rubrics.find((r) => r.status === 'FROZEN')
    ?? [...rubrics].sort((a, b) => b.version - a.version)[0]
}

function RubricLink({ rubric }: { rubric: RubricSummary | undefined }) {
  if (!rubric) return <span style={{ color: 'var(--text-muted)' }}>none yet</span>
  return (
    <>
      <Link to={`/rubrics/${rubric.rubricId}`}>v{rubric.version}</Link>
      <span style={{ color: 'var(--text-muted)' }}> · {rubric.status.toLowerCase()}</span>
    </>
  )
}
