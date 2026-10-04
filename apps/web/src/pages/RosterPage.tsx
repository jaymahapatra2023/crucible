import { useState } from 'react'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { AssignBoard } from '../components/AssignBoard.js'
import { updateTeam } from '../lib/intakeApi.js'
import { RosterImportPanel } from '../components/RosterImportPanel.js'
import { ReadinessChecklist } from '../components/ReadinessChecklist.js'
import { PeoplePanel } from '../components/PeoplePanel.js'
import { CorrectionQueue } from '../components/CorrectionQueue.js'
import { ArrivalPanel } from '../components/ArrivalPanel.js'
import { VenuePanel } from '../components/VenuePanel.js'
import { LogisticsPanel } from '../components/LogisticsPanel.js'
import { SlotPanel } from '../components/SlotPanel.js'
import { getUser } from '../lib/session.js'
import {
  assignLogistics, assignMember, createCoach, createParticipant, createRoom, createTeam,
  getBoard, getCoaches, getLogistics, getParticipants, getRooms, getRosterReadiness,
  getSlots, planSlots, provisionSlots,
  removeParticipant, setTeamContact, unassignMember, updateCoach, updateParticipant, updateRoom,
  type Coach, type Participant, type PeopleQuery, type Room, type RosterBoard,
  type RosterCheck,
  type SlotPlan, type SlotStatus, type TeamSlot,
  type TeamLogistics,
} from '../lib/rosterApi.js'
import {
  decideCorrection, getCorrections, type Correction,
} from '../lib/confirmApi.js'
import { getArrivals, type ArrivalSummary } from '../lib/arrivalApi.js'

interface PageData {
  board: RosterBoard
  readiness: RosterCheck[]
  people: { participants: Participant[]; total: number }
  rooms: Room[]
  coaches: Coach[]
  logistics: TeamLogistics[]
  slots: { status: SlotStatus; slots: TeamSlot[] }
  /** Empty below organiser: the read is refused and the panel does not appear. */
  corrections: Correction[]
  /** Null below organiser, for the same reason. */
  arrivals: ArrivalSummary | null
}

/**
 * Four jobs, one page.
 *
 * Tabs rather than four routes: an organiser moves between these constantly on the morning of an
 * event — add the person who just arrived, put them on a team, give the team a room — and a page
 * load between each would throw away the position they had in a list of two hundred.
 */
const TABS = ['Assign', 'People', 'Rooms & coaches', 'Logistics', 'Floor plan'] as const
type Tab = (typeof TABS)[number]

/**
 * The roster (E27, E28).
 *
 * Loading the three lists, and putting 200 people on teams. The assignment surface is the reason
 * this page exists; the import panel is how it gets its input.
 *
 * Undo is held here rather than in the board, because it has to survive the reload that follows
 * every action — the board is re-rendered from the server after each change, and state inside it
 * would not last.
 */
export function RosterPage() {
  const [tab, setTab] = useState<Tab>('Assign')
  /** Search, sort and page for the participant list — held here so a refetch keeps them. */
  const [peopleQuery, setPeopleQuery] = useState<PeopleQuery>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<unknown> } | null>(null)
  /** The floor-plan file and its plan, held on the page so a refetch cannot unmount them. */
  const role = getUser()?.role
  const provisioner = role === 'organiser' || role === 'admin'
  const [slotCsv, setSlotCsv] = useState('')
  const [slotPlan, setSlotPlan] = useState<SlotPlan | null>(null)
  const [slotFailure, setSlotFailure] = useState<string | null>(null)

  /** The floor-plan actions report their own failure, beside the file they came from. */
  async function runSlots(fn: () => Promise<SlotPlan>): Promise<void> {
    setBusy(true)
    setSlotFailure(null)
    try {
      setSlotPlan(await fn())
    } catch (err) {
      setSlotFailure(err instanceof Error ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Refreshed through the hook's own `reload`, NOT by changing a dependency.
   *
   * A dependency change means the previous result answers a different question, so the hook
   * discards it and the page blanks — which unmounts the assignment surface and takes the
   * focused search box with it. `reload` asks the same question again and keeps the last answer
   * on screen while it does.
   */
  const { state, reload } = useAsyncData<PageData>(
    async () => {
      const [
        board, people, rooms, coaches, logistics, slots, corrections, arrivals,
      ] = await Promise.all([
        getBoard(), getParticipants(peopleQuery), getRooms(), getCoaches(), getLogistics(),
        getSlots(),
        // Absent below organiser: the queue holds names and addresses, so the read is refused
        // and the panel simply does not appear.
        getCorrections('PENDING').catch(() => [] as Correction[]),
        getArrivals().catch(() => null),
      ])
      return {
        board, people, rooms, coaches, logistics, slots, corrections, arrivals,
        readiness: await getRosterReadiness().catch(() => [] as RosterCheck[]),
      }
    },
    // The participant query is a dependency because it changes WHAT is asked for. The
    // assignment board is refreshed through `reload` instead, so it keeps its focus.
    [peopleQuery.search, peopleQuery.sort, peopleQuery.page],
  )

  /**
   * Run an action and refresh.
   *
   * `blocking` is false for assignment, which is the one action done hundreds of times. Blocking
   * it would make the fast path a sequence of round trips with the operator waiting, and — worse —
   * a keystroke arriving during a save would be dropped rather than queued. Assignments are
   * independent of each other, so several in flight is correct rather than merely tolerated.
   *
   * Everything else blocks. Those are rare, and a second click on "remove" while the first is in
   * flight has nothing useful to mean.
   */
  async function act(
    what: () => Promise<unknown>,
    options: {
      blocking?: boolean
      undoable?: { label: string; run: () => Promise<unknown> }
    } = {},
  ) {
    const blocking = options.blocking !== false
    if (blocking) setBusy(true)
    setFailure(null)
    try {
      await what()
      setUndo(options.undoable ?? null)
      reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be done.')
    } finally {
      if (blocking) setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading the roster" />
  if (state.status === 'error') {
    return (
      <ErrorState title="The roster could not be loaded" message={state.error.message}
        detail={state.error.code} onRetry={reload} />
    )
  }

  const {
    board, readiness, people, rooms, coaches, logistics, slots, corrections, arrivals,
  } = state.data

  return (
    <section>
      <h1 style={{ fontSize: 19 }}>Roster</h1>

      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      <nav aria-label="Roster sections" style={{
        display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 14,
      }}>
        {TABS.map((name) => (
          <button
            key={name} type="button" onClick={() => setTab(name)}
            aria-current={tab === name ? 'page' : undefined}
            style={{
              font: 'inherit', padding: '6px 12px', cursor: 'pointer',
              background: 'none', border: 'none',
              // Never colour alone (P5.4): the current tab is also the only bold one and carries
              // aria-current for anyone not reading the underline.
              fontWeight: tab === name ? 700 : 400,
              borderBottom: `2px solid ${tab === name ? 'var(--accent, var(--text))' : 'transparent'}`,
            }}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === 'Assign' && (
        <>
        <AssignBoard
          onEditTeam={(teamId, patch) => void act(async () => { await updateTeam(teamId, patch) })}
          board={board} busy={busy}
          undoable={undo?.label ?? null}
          onUndo={() => void act(() => undo!.run())}
          onAssign={(teamId, participantId) => {
            const person = board.unassigned.find((p) => p.participantId === participantId)
            const team = board.teams.find((t) => t.teamId === teamId)
            void act(() => assignMember(teamId, participantId), {
              blocking: false,
              undoable: {
                label: `${person?.fullName ?? 'that person'} → ${team?.displayName ?? 'that team'}`,
                run: () => unassignMember(participantId),
              },
            })
          }}
          onUnassign={(participantId) => {
            // Deliberately not undoable: putting somebody back requires knowing which team they
            // came from, and offering an undo that guessed would be worse than offering none.
            void act(() => unassignMember(participantId))
          }}
          onSetContact={(teamId, participantId) =>
            void act(() => setTeamContact(teamId, participantId))}
          onCreateTeam={(displayName, participantId) => {
            // Blocking, unlike assignment: creating a team is rare, and the board has to have
            // caught up before the next Enter lands or that keystroke goes to the old selection.
            // Deliberately not undoable — a team with somebody on it cannot be withdrawn by
            // deleting it, and an undo that removed the member instead would be a different act
            // than the one it offered to reverse.
            void act(() => createTeam(displayName, participantId))
          }}
        />

          <RosterImportPanel busy={busy} onImported={reload} />
        </>
      )}

      {tab === 'People' && (
        <>
          <CorrectionQueue
            corrections={corrections} busy={busy} canDecide={provisioner}
            onDecide={(id, approve) => void act(() => decideCorrection(id, approve))}
          />
          <PeoplePanel
            people={people.participants} total={people.total} busy={busy}
            query={peopleQuery} onQuery={setPeopleQuery}
            onAdd={(input) => void act(() => createParticipant(input))}
            onSave={(id, changes) => void act(() => updateParticipant(id, changes))}
            onRemove={(id, reason) => void act(() => removeParticipant(id, reason))}
          />
        </>
      )}

      {tab === 'Rooms & coaches' && (
        <>
          <ArrivalPanel state={arrivals} busy={busy} onRefresh={() => void reload()} />
          <VenuePanel
            rooms={rooms} coaches={coaches} busy={busy}
            onAddRoom={(input) => void act(() => createRoom(input))}
            onSaveRoom={(id, changes) => void act(() => updateRoom(id, changes))}
            onAddCoach={(input) => void act(() => createCoach(input))}
            onSaveCoach={(id, changes) => void act(() => updateCoach(id, changes))}
          />
        </>
      )}

      {tab === 'Floor plan' && (
        <SlotPanel
          status={slots.status} slots={slots.slots} plan={slotPlan} busy={busy}
          failure={slotFailure} csv={slotCsv}
          onCsvChange={(next) => { setSlotCsv(next); setSlotPlan(null); setSlotFailure(null) }}
          onPlan={() => void runSlots(() => planSlots(slotCsv))}
          {...(provisioner && {
            onProvision: () => void runSlots(async () => {
              const done = await provisionSlots(slotCsv)
              if (done.provisioned) { setSlotCsv(''); reload() }
              return done
            }),
          })}
        />
      )}

      {tab === 'Logistics' && (
        <LogisticsPanel
          teams={board.teams} logistics={logistics} rooms={rooms} coaches={coaches} busy={busy}
          onAssign={(teamId, changes) => void act(() => assignLogistics(teamId, changes))}
        />
      )}


      {readiness.length > 0 && (
        <div style={{ marginTop: 24 }}>
          {/* The same component the evaluation readiness uses, so there is one visual language
              for "here is what is outstanding" rather than two. */}
          <ReadinessChecklist report={{
            cohortKey: 'roster',
            ready: readiness.every((c) => c.status === 'PASS'),
            checks: readiness,
          }} />
        </div>
      )}
    </section>
  )
}
