import { useEffect, useRef, useState } from 'react'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { FormField, TextArea, TextInput } from '../components/FormField.js'
import {
  BuildFields, IntakeBanner, SubmissionProblems, SubmissionWarnings,
} from '../components/BuildFields.js'
import { TeamEntryStatus } from '../components/TeamEntryStatus.js'
import {
  getIntakeWindow, getOpenChallenges, resolveToken, rubricHref, submissionProblems,
  submissionWarnings, submitEntry,
  type IntakeStatus, type OpenChallenge, type SubmissionDraft, type SubmissionReceipt,
  type TeamView,
} from '../lib/submitApi.js'

/**
 * Where a team enters their work (E03-S01).
 *
 * Public by design: teams have no Crucible account, and creating one for a weekend event would
 * put an account-recovery problem between a team and their deadline. They authenticate with the
 * scoped submission token their organiser issued.
 *
 * The page tells a team four things it would otherwise learn too late: whether intake is open at
 * all, what standard they will be judged by, what will be wrong with their entry before they send
 * it, and — afterwards — exactly which commit was locked, so there is no ambiguity about what
 * will be evaluated.
 */
const EMPTY: SubmissionDraft = {
  contactEmail: '', challengeId: 0, repoUrl: '',
  buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', artifactUrls: [],
}

export function SubmitPage() {
  const [draft, setDraft] = useState<SubmissionDraft>(EMPTY)
  // `null` until the team types: the resolved team's contact stands in meanwhile (E45-S01).
  const [contact, setContact] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  // A second click before React re-renders the disabled button must not send a second entry.
  const inFlight = useRef(false)
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const { state, reload } = useAsyncData<{ window: IntakeStatus; challenges: OpenChallenge[] }>(
    async () => {
      const [w, challenges] = await Promise.all([getIntakeWindow(), getOpenChallenges()])
      return { window: w, challenges }
    },
    [],
  )

  const set = <K extends keyof SubmissionDraft>(k: K, v: SubmissionDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  const resolved = useResolvedTeam(token)
  const entry = withResolvedContact(draft, contact, resolved)

  if (state.status === 'loading') return <LoadingState label="Checking whether intake is open" />
  if (state.status === 'error') {
    return (
      <ErrorState title="The submission page could not be loaded" message={state.error.message}
        detail={state.error.code} onRetry={reload} />
    )
  }

  const { window: intake, challenges } = state.data
  const open = intake.state === 'OPEN'
  const problems = submissionProblems(entry, token)
  // Shown as soon as there is something to say, rather than waiting for a submit attempt: the
  // point is to catch the mistake while the team is still looking at the field.
  const warnings = submissionWarnings(entry)
  const chosen = challenges.find((c) => c.challengeId === draft.challengeId) ?? null

  if (receipt) return <Receipt receipt={receipt} onAnother={() => { setReceipt(null); setDraft(EMPTY); setContact(null) }} />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (problems.length > 0 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailure(null)
    try {
      setReceipt(await submitEntry(entry, token))
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Your entry could not be submitted.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 19 }}>Submit your entry</h1>

      <IntakeBanner state={intake.state} message={intake.message}
        closesAt={intake.window?.closesAt ?? null} />

      <TeamEntryStatus token={token} />

      <form onSubmit={submit}>
        <TokenField token={token} onChange={setToken} resolved={resolved} />

        <FormField id="t-email" label="Contact email" required
          hint="Where we write if your repository will not clone. Filled from your team; change it if it is wrong.">
          <TextInput id="t-email" type="email" value={entry.contactEmail}
            onChange={(e) => setContact(e.target.value)} />
        </FormField>

        <FormField id="t-challenge" label="Challenge" required>
          <select id="t-challenge" value={draft.challengeId}
            onChange={(e) => set('challengeId', Number(e.target.value))}
            style={{
              width: '100%', padding: '6px 8px', font: 'inherit',
              border: '1px solid var(--border)', borderRadius: 6,
            }}>
            <option value={0}>Choose a challenge…</option>
            {challenges.map((c) => (
              <option key={c.challengeId} value={c.challengeId}>{c.name}</option>
            ))}
          </select>
        </FormField>

        <RubricLink challenge={chosen} />

        <FormField id="t-repo" label="Repository URL" required
          hint="Public, or readable by the organiser's access token. We record the commit at the moment you submit and evaluate that one — later pushes do not change it.">
          <TextInput id="t-repo" value={draft.repoUrl} placeholder="https://github.com/team/project"
            onChange={(e) => set('repoUrl', e.target.value)} />
        </FormField>

        <BuildFields draft={draft} onChange={set} />

        <FormField id="t-artifacts" label="Extra links"
          hint="A demo video, slides, a hosted instance. One per line. Optional.">
          <TextArea id="t-artifacts" value={draft.artifactUrls.join('\n')}
            onChange={(e) => set('artifactUrls',
              e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} />
        </FormField>

        <SubmissionWarnings warnings={warnings} />
        <SubmissionProblems problems={touched ? problems : []} />

        {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

        <button type="submit" disabled={busy || !open}>
          {busy ? 'Submitting…' : 'Submit entry'}
        </button>
        {!open && (
          <p style={{ color: 'var(--text-muted)' }}>
            Submission is closed. Contact your organiser if you believe this is wrong.
          </p>
        )}
      </form>
    </section>
  )
}

/**
 * What was recorded.
 *
 * The commit hash is the important line: it is what will be evaluated, and a team that pushes
 * afterwards needs to know that push will not be seen unless they resubmit.
 */
function Receipt({
  receipt, onAnother,
}: {
  receipt: SubmissionReceipt
  onAnother: () => void
}) {
  return (
    <section style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 19 }}>Entry received</h1>
      <div style={{
        border: '1px solid var(--ok)', borderRadius: 8, padding: 16, background: 'var(--surface)',
      }}>
        <p style={{ marginTop: 0 }}>
          <strong>{receipt.teamName}</strong> — submission #{receipt.submissionId}
          {receipt.version > 1 && <> (version {receipt.version})</>}
        </p>
        <p><strong>Repository: </strong>{receipt.repoUrl}</p>
        <p>
          <strong>Validation: </strong>{receipt.validationStatus}
          {receipt.validationDetail && <> — {receipt.validationDetail}</>}
        </p>
        <CommitLine receipt={receipt} />
      </div>
      <p><button type="button" onClick={onAnother}>Submit another entry</button></p>
    </section>
  )
}

/**
 * The standard, linked from where the entry is made (E17-S04).
 *
 * The rubric is per challenge, so the link appears once one is chosen. A published rubric is
 * already a precondition of accepting entries — it exists precisely so teams can read it — and
 * until now nothing on this page said where.
 */
function RubricLink({ challenge }: { challenge: OpenChallenge | null }) {
  if (!challenge) return null

  if (challenge.rubricSlug === null) {
    return (
      <p role="status" style={{ color: 'var(--warn)' }}>
        The rubric for <strong>{challenge.name}</strong> has not been published yet. Ask your
        organiser for it before you submit — you are entitled to read it first.
      </p>
    )
  }

  return (
    <p>
      <a href={rubricHref(challenge.rubricSlug)} target="_blank" rel="noreferrer">
        Read the rubric for {challenge.name}
      </a>
      <br />
      <span style={{ color: 'var(--text-muted)' }}>
        This is the standard your entry will be judged against, exactly as it was published.
      </span>
    </p>
  )
}

/**
 * What commit this entry will be judged on (E38).
 *
 * Three states, not two. The original had two — a locked commit, or a warning that "the
 * repository could not be read" — and showed the warning whenever no commit was locked. But a
 * commit is locked when the **intake window closes**, not at submit time, so every team who
 * submitted successfully before the deadline was told their repository could not be read.
 *
 * That is the worst possible false alarm: it appears on the one screen entrants see, at the
 * moment they have just succeeded, and it tells them to fix something that is not broken. A
 * team acting on it re-submits repeatedly, or spends the evening chasing repository permissions
 * that were always correct.
 *
 * The distinction the receipt has to carry is whether VALIDATION passed, which is a fact it
 * already holds and was not reading.
 */
export function CommitLine({ receipt }: { receipt: SubmissionReceipt }) {
  if (receipt.lockedCommitSha) {
    return (
      <p>
        <strong>Commit locked: </strong><code>{receipt.lockedCommitSha}</code>
        <br />
        <span style={{ color: 'var(--text-muted)' }}>
          This exact commit is what will be evaluated. Pushing more work will not change it —
          submit again if you want a later commit judged.
        </span>
      </p>
    )
  }

  // Validated, but the window has not closed yet. This is the ordinary successful path and it
  // reads as reassurance, because that is what it is.
  if (receipt.validationStatus === 'VALID') {
    return (
      <p>
        <strong>Commit: </strong>not locked yet.
        <br />
        <span style={{ color: 'var(--text-muted)' }}>
          Your repository was read successfully. The commit you are judged on is taken when
          intake closes — so keep working, and whatever is on your default branch at that moment
          is what gets evaluated.
        </span>
      </p>
    )
  }

  // Not read YET: the checks ran out of their time budget (E45-S02), which says nothing about
  // the team. Telling them the repository "could not be read" would send them to fix a problem
  // that does not exist — the E38 false alarm again, from a new direction.
  if (receipt.validationStatus === 'PENDING') {
    return (
      <p>
        <strong>Commit: </strong>not checked yet.
        <br />
        <span style={{ color: 'var(--text-muted)' }}>
          Your entry is recorded. Its checks did not finish in time and will be run again
          shortly — nothing for you to fix. Use "Check my entry" above to see the result.
        </span>
      </p>
    )
  }

  return (
    <p style={{ color: 'var(--warn)' }}>
      <strong>Your repository could not be read.</strong> Your entry is recorded and your
      organiser can see it, but nothing can be evaluated until this is fixed — correct the
      problem above and submit again.
    </p>
  )
}

/**
 * The team's own contact fills the email field once the token resolves; the team may still
 * correct it (E45-S01).
 *
 * Derived, not synced: `contact` is what the team typed (or nothing yet) and the resolved
 * contact stands in until they do. An effect that copied the resolved value into the draft would
 * be a second source of truth for the same field, and a team who cleared it to retype would have
 * watched it refill.
 */
function withResolvedContact(
  draft: SubmissionDraft, contact: string | null, resolved: Resolved,
): SubmissionDraft {
  const fallback = resolved.status === 'ok' ? resolved.view.team.contactEmail : ''
  return { ...draft, contactEmail: contact ?? fallback }
}

/** The token, and the team it resolves to — displayed, never selected or typed (E45-S01). */
function TokenField({
  token, onChange, resolved,
}: {
  token: string
  onChange: (next: string) => void
  resolved: Resolved
}) {
  return (
    <FormField id="t-token" label="Submission token" required
      hint="Your organiser sent this with your team invitation. It identifies your team."
      error={resolved.status === 'error' ? resolved.message : null}>
      <TextInput id="t-token" value={token} onChange={(e) => onChange(e.target.value)} />
      {resolved.status === 'ok' && (
        <p role="status" data-testid="resolved-team" style={{ margin: '4px 0 0', fontSize: 13 }}>
          Submitting as <strong>{resolved.view.team.displayName}</strong>
          <PreviousEntries entries={resolved.view.entries} />
        </p>
      )}
      {resolved.status === 'checking' && (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Checking…</p>
      )}
    </FormField>
  )
}

/** The team's entries so far, by challenge (E45-S01 acceptance 1): a new one supersedes its match. */
function PreviousEntries({ entries }: { entries: TeamView['entries'] }) {
  if (entries.length === 0) return null
  const named = entries.map((e) => `${e.challengeName}${e.version > 1 ? ` (v${e.version})` : ''}`)
  return (
    <span style={{ color: 'var(--text-muted)' }}>
      {' '}· already entered: {named.join(', ')}
    </span>
  )
}

type Resolved =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; view: TeamView }
  | { status: 'error'; message: string }

/**
 * Resolve the token to its team as it is typed, debounced (E45-S01).
 *
 * Derived from the last token that was checked, so an answer for an earlier token is never shown
 * against the current one — without an effect having to clear it.
 */
function useResolvedTeam(token: string): Resolved {
  const [checked, setChecked] = useState<{ token: string; result: Resolved } | null>(null)
  const trimmed = token.trim()

  useEffect(() => {
    if (trimmed.length < 8) return
    let cancelled = false
    const timer = setTimeout(() => {
      resolveToken(trimmed)
        .then((view) => { if (!cancelled) setChecked({ token: trimmed, result: { status: 'ok', view } }) })
        .catch((err: unknown) => {
          if (cancelled) return
          const message = err instanceof Error ? err.message : 'That token could not be checked.'
          setChecked({ token: trimmed, result: { status: 'error', message } })
        })
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [trimmed])

  if (trimmed.length < 8) return { status: 'idle' }
  if (checked !== null && checked.token === trimmed) return checked.result
  return { status: 'checking' }
}
