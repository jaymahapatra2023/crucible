/**
 * Telling everybody a team is registered (migration 097).
 *
 * Three recipients and two messages:
 *
 *  - the whole team gets ONE email saying they are registered, with their room, floor and coach
 *    (migration 103). The registrant is the To and every other member is copied, so a team of
 *    eight is one message rather than eight identical ones;
 *  - every member who gave a Discord username also gets that as a DM, because a DM has one
 *    recipient by construction and a copy list cannot carry it;
 *  - the submission code is NOT in any of it. It goes out later in the day as its own deliberate
 *    act, so a code is not sitting in ninety-nine inboxes from nine in the morning;
 *  - the assigned coach gets the team, the room and the roster, and NOT the code. The code is the
 *    team's identity (E17-S01); a coach who can submit as the team breaks the one fact the
 *    evaluation rests on, however helpfully.
 *
 * Everything here is best-effort and runs after the registration has committed. The team exists.
 * Failing the registration because a mail relay was slow would undo work the team can see on
 * screen, so each failure is recorded and the next recipient is tried.
 */
import { createLogger } from '../../../lib/logger.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { redactString } from '../../../lib/redact.js'
import { renderMail } from '../../submissions/services/mailTemplates.js'
import { deadlineWording } from '../../submissions/services/windowService.js'
import { selectLogistics, selectParticipant } from '../db/rosterDb.js'

const log = createLogger('roster', 'notices')

/**
 * Gap between consecutive sends in a loop.
 *
 * Relays and chat APIs both treat a burst differently from a steady trickle: Google throttles
 * well below its daily cap on messages per minute, and the Discord client's breaker reads three
 * refusals in a row as an outage and stops trying. A fifth of a second between sends is invisible
 * to a registering team and keeps both inside their normal behaviour.
 */
const SEND_GAP_MS = 200

let pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Test seam — so a suite does not wait out the pacing. */
export function setNoticePacer(fn: (ms: number) => Promise<void>): void { pause = fn }

export interface NoticeOutcome {
  /** Members who were sent the code, besides the registrant. */
  membersNotified: number
  membersFailed: number
  /** Null when the team has no coach yet, which is the case for an unplaced team. */
  coachNotified: boolean | null
}

export async function notifyAfterRegistration(input: {
  teamId: number
  displayName: string
  /** Rendered once by the caller and reused, so every member reads the identical message. */
  registrationFacts: Record<string, string | number>
  memberIds: readonly number[]
  /** Already emailed by the caller, and copied on that message; not messaged twice. */
  registrantParticipantId: number
  actor: string
}): Promise<NoticeOutcome> {
  const people = await Promise.all(input.memberIds.map((id) => selectParticipant(id)))
  const named = people.filter((p): p is NonNullable<typeof p> => p !== null)

  const outcome: NoticeOutcome = { membersNotified: 0, membersFailed: 0, coachNotified: null }

  const others = named.filter((p) => p.participantId !== input.registrantParticipantId)
  /*
   * The EMAIL already went: the registrant's message copied every other member (see
   * `sendTokenAfterCommit`). What is left is Discord, one DM per member who gave a username,
   * which a copy list cannot do because a DM has exactly one recipient.
   *
   * A member with no Discord identity needs nothing here — they are on the team email.
   */
  const dmable = others.filter((p) => p.discordUserId !== null)
  if (dmable.length > 0) {
    const rendered = await renderMail('mail.team_registered', input.registrationFacts)
    for (const [i, person] of dmable.entries()) {
      // Paced. Discord has no daily cap worth worrying about, but a tight loop across forty-eight
      // teams is a burst, and the breaker in the client reads a burst of refusals as an outage.
      if (i > 0) await pause(SEND_GAP_MS)
      try {
        await mail().send({
          to: person.email, subject: rendered.subject, body: rendered.body,
          discordUserId: person.discordUserId,
          // One key per recipient per team: a retry is the same message, two members are not.
          idempotencyKey: `team-registered/${input.teamId}/member/${person.participantId}`,
        })
        outcome.membersNotified += 1
      } catch (err) {
        outcome.membersFailed += 1
        log.warn('member could not be sent the code', {
          teamId: input.teamId, participantId: person.participantId,
          detail: redactString(err instanceof Error ? err.message : 'unknown'),
        })
      }
    }
  }

  outcome.coachNotified = await notifyCoach({
    teamId: input.teamId, displayName: input.displayName,
    members: named.map((p) => p.fullName),
  })

  log.info('registration notices sent', {
    teamId: input.teamId, members: outcome.membersNotified,
    membersFailed: outcome.membersFailed, coach: outcome.coachNotified,
  })
  return outcome
}

async function notifyCoach(input: {
  teamId: number; displayName: string; members: readonly string[]
}): Promise<boolean | null> {
  const [logistics] = await selectLogistics([input.teamId])
  if (!logistics?.coachEmail || !logistics.coachName) return null

  try {
    const rendered = await renderMail('mail.coach_team_registered', {
      coach_name: logistics.coachName,
      team_name: input.displayName,
      room_label: logistics.roomLabel ?? 'no room recorded yet',
      // The floor as well (migration 103): a room number without one is an instruction to
      // wander a building with four of them.
      room_location: logistics.roomLocation ?? 'floor not recorded',
      members: input.members.map((m) => `  - ${m}`).join('\n'),
      deadline: await deadlineWording(),
    })
    await mail().send({
      to: logistics.coachEmail, subject: rendered.subject, body: rendered.body,
      idempotencyKey: `coach-registered/${input.teamId}`,
    })
    return true
  } catch (err) {
    log.warn('coach could not be told about their team', {
      teamId: input.teamId,
      detail: redactString(err instanceof Error ? err.message : 'unknown'),
    })
    return false
  }
}

/**
 * The facts a newly registered team is told: where they sit, who their coach is, who is on it.
 *
 * Read from the roster after the claim has committed, so the room and coach are the ones the
 * slot actually carries rather than the ones the form hoped for. Rendered once by the caller and
 * reused for the email and every DM, so no two members read a different message.
 */
export async function registrationFacts(input: {
  teamId: number
  displayName: string
  memberIds: readonly number[]
}): Promise<Record<string, string | number>> {
  const [logistics] = await selectLogistics([input.teamId])
  const people = await Promise.all(input.memberIds.map((id) => selectParticipant(id)))
  const names = people.flatMap((p) => (p === null ? [] : [p.fullName]))

  return {
    team_name: input.displayName,
    member_count: names.length,
    // Said plainly when unknown. An unplaced team is a real state — forty slots and sixty teams
    // is a thing that happens — and "no room yet" is more use than a blank line.
    room_label: logistics?.roomLabel ?? 'not assigned yet — ask an organiser',
    room_location: logistics?.roomLocation ?? 'not assigned yet',
    coach_name: logistics?.coachName ?? 'not assigned yet — ask an organiser',
    members: names.map((m) => `  - ${m}`).join('\n'),
  }
}

/**
 * Tell the registrant and their team they are registered, after commit and only after.
 *
 * No submission code, and NO delivery recorded (migration 103): the code has not been sent, so
 * recording a token delivery here would tell the organiser's panel that forty-eight teams hold
 * a code when none of them does. The later send is what records it.
 */
export async function sendRegisteredAfterCommit(input: {
  teamId: number
  displayName: string
  facts: Record<string, string | number>
  to: string
  copyTo: readonly string[]
  discordUserId: string | null
  actor: string
}): Promise<{ via: 'discord' | 'email' | 'both' | null; fallbackReason: string | null }> {
  try {
    const rendered = await renderMail('mail.team_registered', input.facts)
    const result = await mail().send({
      to: input.to, copyTo: input.copyTo, discordUserId: input.discordUserId,
      subject: rendered.subject, body: rendered.body,
      idempotencyKey: `team-registered/${input.teamId}`,
    })
    return {
      via: result.delivered ? (result.channel ?? 'email') : null,
      fallbackReason: result.fallbackReason ?? null,
    }
  } catch (err) {
    // Best-effort, like every other notice here: the team exists and can see that on screen.
    log.error('registration notice could not be sent', {
      teamId: input.teamId,
      detail: redactString(err instanceof Error ? err.message : 'unknown'),
    })
    return { via: null, fallbackReason: null }
  }
}
