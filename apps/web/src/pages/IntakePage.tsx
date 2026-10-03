import { useState } from 'react'
import { getUser } from '../lib/session.js'
import { EventLinksPanel } from '../components/EventLinksPanel.js'
import { ChasePanel } from '../components/ChasePanel.js'
import { getChaseList, sendReminders, type TeamToChase } from '../lib/reminderApi.js'
import {
  bulkTokens, getDeliveryState, getIntakeDashboard, getIntakeStatus, issueToken, listSubmissions, listTeams, listTokens, lockSubmissionWindow, reissueToken, revealToken, revokeToken, runPreflight, setSubmissionWindow, tokensForTeams, type BulkPlan, type DeliveryReport, type IntakeDashboard, type IntakeStatus, type IssuedToken, type SubmissionPage, type SubmissionToken, type TeamDelivery, type TeamListing, type TokenSort, updateTeam,
} from '../lib/intakeApi.js'
import { handOutCodes, type HandoutPlan } from '../lib/codeHandoutApi.js'
import { TokenPanel } from '../components/TokenPanel.js'
import { BulkTokenPanel } from '../components/BulkTokenPanel.js'
import { DeliveryPanel } from '../components/DeliveryPanel.js'
import { CodeHandoutPanel } from '../components/CodeHandoutPanel.js'
import { SubmissionsTable, type EntryQuery } from '../components/SubmissionsTable.js'
import { listChallenges, type Challenge } from '../lib/challengeApi.js'
import { EventSetup } from '../components/EventSetup.js'
import { ProvenanceQueue } from '../components/ProvenanceQueue.js'
import {
  getEventSettings, getFlaggedProvenance, resolveProvenance, setEvaluationDate, setEventUrls, setEventWindow,
  type EventSettings, type FlaggedProvenance,
} from '../lib/eventApi.js'
import { WindowPanel } from '../components/WindowPanel.js'
import { DownloadButton } from '../components/DownloadButton.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { IntakeCounts } from '../components/IntakeCounts.js'

/** Shown when the entry list cannot be read, so the rest of the dashboard still renders. */
const EMPTY_PAGE: SubmissionPage =
  { items: [], total: 0, page: 1, pageSize: 0, truncated: false }

/** Intake dashboard (E03-S05): chase problems before the deadline, not after it. */
export function IntakePage() {
  const [busy, setBusy] = useState(false)
  // The one-time code handout (migration 103): checked first, then sent.
  const [handout, setHandout] = useState<HandoutPlan | null>(null)
  const role = getUser()?.role
  const organiser = canRemind(role)
  const admin = role === 'admin'
  const [issued, setIssued] = useState<IssuedToken | null>(null)
  // The bulk file and its result live HERE rather than in the panel: this page blanks to a
  // loading state on every refetch, which unmounts its children — and an unmounted bulk panel
  // takes the only copy of every issued plaintext with it.
  const [bulkCsv, setBulkCsv] = useState('')
  const [bulkPlan, setBulkPlan] = useState<BulkPlan | null>(null)
  const [bulkFailure, setBulkFailure] = useState<string | null>(null)
  // Held HERE for the same reason the bulk plan is: a refetch unmounts the panel, and the
  // composed messages contain tokens that exist nowhere else.
  const [delivered, setDelivered] = useState<DeliveryReport | null>(null)
  /** Filters, sort and page for the entries table — held here so a refetch cannot discard them. */
  const [entryQuery, setEntryQuery] = useState<EntryQuery>({})
  const [tokenSort, setTokenSort] = useState<TokenSort | undefined>(undefined)
  const [failure, setFailure] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const { state, reload } = useAsyncData<{
    dashboard: IntakeDashboard; status: IntakeStatus; tokens: SubmissionToken[]
    teams: TeamListing[]; event: EventSettings; flagged: FlaggedProvenance[]
    delivery: TeamDelivery[]; entries: SubmissionPage; challenges: Challenge[]
    chase: TeamToChase[]
  }>(
    async () => {
      const [dashboard, status, tokens, teams, event, flagged, delivery, chase] = await Promise.all([
        getIntakeDashboard(), getIntakeStatus(),
        // Tokens are organiser-only; a viewer sees the dashboard without them rather than an
        // error page for a panel they were never meant to act on.
        listTokens(tokenSort).catch(() => [] as SubmissionToken[]),
        listTeams().catch(() => [] as TeamListing[]),
        getEventSettings(),
        getFlaggedProvenance().catch(() => [] as FlaggedProvenance[]),
        getDeliveryState().catch(() => [] as TeamDelivery[]),
        getChaseList().catch(() => [] as TeamToChase[]),
      ])
      /*
       * Both tolerated, like every other optional read on this page.
       *
       * The entries table was added without a `catch`, and a single 400 from it took the whole
       * dashboard down — counts, chasing list and all. A panel must not be able to remove the
       * page it sits on; the empty page is a worse outcome than a missing panel.
       */
      const [entries, challenges] = await Promise.all([
        listSubmissions(entryQuery).catch(() => EMPTY_PAGE),
        listChallenges().catch(() => [] as Challenge[]),
      ])
      return { dashboard, status, tokens, teams, event, flagged, delivery, entries, challenges, chase }
    },
    [reloadKey, entryQuery.challengeId, entryQuery.status, entryQuery.sort, entryQuery.page,
     tokenSort],
  )

  /**
   * Check a file, or register it.
   *
   * Not routed through `act`: that refetches the page on success, and a refetch blanks the page
   * while it runs — which would unmount the panel holding the tokens that were just issued and
   * can never be read again. The teams list beside this is refreshed only once they are saved.
   */
  async function runBulk(confirm: boolean, forTeams = false) {
    setBusy(true)
    setBulkFailure(null)
    try {
      setBulkPlan(forTeams ? await tokensForTeams(confirm) : await bulkTokens(bulkCsv, confirm))
    } catch (err) {
      setBulkPlan(null)
      setBulkFailure(err instanceof Error ? err.message : 'That file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  async function act(what: () => Promise<void>) {
    setBusy(true)
    setFailure(null)
    try {
      await what()
      setReloadKey((n) => n + 1)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading intake" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Intake could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={reload}
      />
    )
  }

  const { dashboard, status, tokens, teams, event, flagged, delivery, entries, challenges, chase }
    = state.data
  const windowTone = status.state === 'OPEN' ? 'var(--ok)'
    : status.state === 'LOCKED' ? 'var(--danger)' : 'var(--warn)'

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Submission intake</h1>
        {/* Addressed by test id as well as by role: the page carries other live regions — the
            teams that cannot submit, for one — and "the status" stopped being unambiguous. */}
        <span role="status" data-testid="intake-state"
          style={{ color: windowTone, fontWeight: 600 }}>{status.state}</span>
        <span style={{ color: 'var(--text-muted)' }}>{status.message}</span>
        <span style={{ marginLeft: 'auto' }}>
          <DownloadButton
            path="/submissions/export.csv"
            filename="submissions.csv"
            label="Export CSV"
            testId="export-intake"
          />
        </span>
      </header>

      <IntakeCounts dashboard={dashboard} />

      <EventLinksPanel registerUrl={event.registerUrl} submitUrl={event.submitUrl}
        canSave={getUser()?.role === 'admin'} busy={busy}
        onSave={(urls) => void act(async () => { await setEventUrls(urls) })} />

      <ChasePanel teams={chase} busy={busy}
        {...only(organiser, {
          onRemind: (ids?: number[]) => void act(async () => { await sendReminders(ids) }),
        })} />

      <h2 style={{ fontSize: 15 }}>By challenge</h2>
      {dashboard.byChallenge.length === 0 ? (
        <EmptyState
          title="No submissions yet"
          explanation="Entries appear here as teams submit. Share the published rubric and the submission link."
        />
      ) : (
        <table aria-label="Submissions by challenge">
          <thead>
            <tr>
              <th scope="col">Challenge</th>
              <th scope="col">Total</th>
              <th scope="col">Valid</th>
              <th scope="col">Needs attention</th>
              <th scope="col">Dockerfile</th>
              <th scope="col">Command</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.byChallenge.map((c) => (
              <tr key={c.challengeId}>
                <td>#{c.challengeId}</td>
                <td>{c.total}</td>
                <td>{c.valid}</td>
                <td>{c.total - c.valid}</td>
                <td>{c.dockerfileBuilds}</td>
                <td>{c.commandBuilds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: 15, marginTop: 28 }}>
        Needs chasing{' '}
        <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
          ({dashboard.failing.length})
        </span>
      </h2>
      {dashboard.failing.length === 0 ? (
        <EmptyState
          title="Nothing to chase"
          explanation="Every current submission validated. Re-checks continue until the window closes."
        />
      ) : (
        <table aria-label="Submissions needing chasing">
          <thead>
            <tr>
              <th scope="col">Team</th>
              {/* Chasing a team means walking to them, so where they are belongs beside who
                  they are (E27-S03 acceptance 4). */}
              <th scope="col">Where</th>
              <th scope="col">Contact</th>
              <th scope="col">Status</th>
              <th scope="col">What is wrong</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.failing.map((f) => (
              <tr key={f.submissionId}>
                <td>{f.teamName}</td>
                <td>
                  {f.roomLabel ?? <span style={{ color: 'var(--text-muted)' }}>no room</span>}
                  {f.coachName !== null && (
                    <span style={{ color: 'var(--text-muted)' }}> · {f.coachName}</span>
                  )}
                </td>
                <td><a href={`mailto:${f.contactEmail}`}>{f.contactEmail}</a></td>
                <td style={{ color: 'var(--danger)' }}>{f.validationStatus}</td>
                <td>{f.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {/* Below organiser the page reads; it offers nothing the API would refuse (P8.2). */}
      <WindowPanel
        status={status} busy={busy}
        {...only(organiser, {
          onSave: (input: { name: string; opensAt: string; closesAt: string }) =>
            void act(async () => { await setSubmissionWindow(input) }),
          onLock: () => void act(async () => { await lockSubmissionWindow() }),
        })}
      />

      {admin && (
        <EventSetup
          settings={event} busy={busy}
          onSaveDate={(date) => void act(async () => { await setEvaluationDate(date) })}
          onSaveWindow={(startsAt, endsAt) =>
            void act(async () => { await setEventWindow(startsAt, endsAt) })}
        />
      )}

      <ProvenanceQueue
        entries={flagged} busy={busy}
        {...only(organiser, {
          onResolve: (submissionId: number, reason: string) =>
            void act(async () => { await resolveProvenance(submissionId, reason) }),
        })}
      />

      {organiser && (
        <BulkTokenPanel
          csv={bulkCsv} plan={bulkPlan} busy={busy} failure={bulkFailure}
          onCsvChange={(next) => { setBulkCsv(next); setBulkPlan(null); setBulkFailure(null) }}
          onRun={(confirm) => void runBulk(confirm)}
          onRunForTeams={(confirm) => void runBulk(confirm, true)}
          onSaved={() => { setBulkCsv(''); setBulkPlan(null); setReloadKey((k) => k + 1) }}
        />
      )}

      <SubmissionsTable
        page={entries} busy={busy}
        challengeNames={new Map(challenges.map((c) => [c.challengeId, c.name]))}
        query={entryQuery} onQuery={setEntryQuery}
        {...only(organiser, {
          onRunPreflight: (id: number, force: boolean) => void act(async () => { await runPreflight(id, force) }),
        })}
      />

      <DeliveryPanel
        state={delivery} report={delivered} busy={busy}
        {...only(organiser, {
          onPrepare: () => void act(async () => {
            const plan = await tokensForTeams(true, true)
            setDelivered(plan.delivery ?? null)
            setReloadKey((k) => k + 1)
          }),
        })}
        onDownload={() => downloadMessages(delivered)}
      />

      <CodeHandoutPanel
        plan={handout} busy={busy} canSend={organiser}
        onCheck={() => void act(async () => { setHandout(await handOutCodes(false)) })}
        onSend={() => void act(async () => {
          setHandout(await handOutCodes(true))
          setReloadKey((k) => k + 1)
        })}
      />

      <TokenPanel
        tokens={tokens} teams={teams} issued={issued} busy={busy}
        sort={tokenSort} onSort={setTokenSort}
        onDismiss={() => setIssued(null)}
        {...only(organiser, {
          onIssue: (input: { label: string; contactEmail: string }) =>
            void act(async () => { setIssued(await issueToken(input)) }),
          onReissue: (teamId: number, reason: string) =>
            void act(async () => { setIssued(await reissueToken(teamId, reason)) }),
          onEditTeam: (teamId: number, patch: { displayName?: string; contactEmail?: string }) =>
            void act(async () => { await updateTeam(teamId, patch) }),
        })}
        {...only(admin, {
          onReveal: (tokenId: number) => void act(async () => {
            const outcome = await revealToken(tokenId)
            if (!outcome.available) throw new Error(outcome.reason)
            setIssued({
              tokenId: outcome.tokenId, label: outcome.teamName, token: outcome.token,
              expiresAt: null, teamId: outcome.teamId, teamName: outcome.teamName, revealed: true,
            })
          }),
        })}
        {...only(organiser, { onRevoke: (tokenId: number, label: string) => {
          if (globalThis.confirm(
            `Revoke ${label}'s token? It stops working immediately, and they cannot submit `
            + `until you issue another.`)) void act(async () => { await revokeToken(tokenId) })
        } })}
      />
    </section>
  )
}

/**
 * Save the composed messages as a file, in the browser, from what is already on screen.
 *
 * Deliberately NOT a request to the server: there is nothing there to ask for. The messages
 * contain the tokens, the tokens exist only in the response that issued them, and the server
 * stores neither (P8.3). This turns the one copy into a file before it is lost.
 */
function downloadMessages(report: DeliveryReport | null): void {
  if (!report || report.messages.length === 0) return

  const text = report.messages
    .map((m) => [`To: ${m.to}`, `Subject: ${m.subject}`, '', m.body].join('\n'))
    .join('\n\n' + '─'.repeat(60) + '\n\n')

  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'crucible-team-messages.txt'
  link.click()
  URL.revokeObjectURL(url)
}

/** Reminding is an organiser's act; a viewer sees the list and no button that would 403. */
const canRemind = (role: string | undefined): boolean => role === 'organiser' || role === 'admin'

/** Props offered only to a role the API would not refuse: an absent callback hides its control. */
const only = <T extends object>(on: boolean, props: T): T | Record<string, never> => (on ? props : {})
