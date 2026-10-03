/**
 * Sending every registered team its submission code, once, as a deliberate act (migration 103).
 *
 * Registration no longer carries the code. A team registers in the half hour before coding
 * starts, when a code is of no use to them, and a code emailed at 9am sits in ninety-nine
 * inboxes all day with every hour another chance of it being forwarded or pasted into a channel.
 * So the registration email says where to sit, and this says how to submit.
 *
 * One activity, run when the organiser decides — mid-afternoon, once teams are settled. It is
 * idempotent on the delivery record: a team already sent its code is reported and not sent
 * again, so running it twice does not mean two emails, and running it again after adding a late
 * team sends only to the late team.
 *
 * The plaintext is recovered from the stored cipher (ADR 0005), which is the same mechanism an
 * organiser uses to read a code back to a team that lost it. A token issued without a reveal key,
 * or whose copy was purged when the window locked, is reported as such rather than skipped: the
 * team still needs its code and somebody has to know.
 */
import { createLogger } from '../../../lib/logger.js'
import { query } from '../../../db/pool.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { revealSubmissionToken } from './tokenReveal.js'
import { prepareDelivery, type Deliverable, type DeliveryReport } from './tokenDelivery.js'

const log = createLogger('submissions', 'codeHandout')

/** Gap between sends, so a burst of fifty does not trip a relay's per-minute throttle. */
const SEND_GAP_MS = 200

let pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Test seam — so a suite does not wait out the pacing. */
export function setHandoutPacer(fn: (ms: number) => Promise<void>): void { pause = fn }

export interface HandoutRow {
  teamId: number
  teamName: string
  contactEmail: string
  /** WAITING: has a code, not yet sent it. SENT: already had it. BLOCKED: cannot be sent. */
  state: 'WAITING' | 'SENT' | 'BLOCKED'
  /** Why it is blocked, in words an organiser can act on. */
  detail: string | null
}

export interface HandoutPlan {
  rows: HandoutRow[]
  summary: { total: number; waiting: number; alreadySent: number; blocked: number }
  /** Null until `confirm` was true and something was actually sent. */
  report: DeliveryReport | null
}

interface Row {
  team_id: number; display_name: string; contact_email: string
  contact_discord_user_id: string | null; token_id: number | null; sent: boolean
}

/**
 * Teams that hold a working code, and whether each has been sent it.
 *
 * Keyed on HOLDING A CODE rather than on having claimed a slot. A registration arriving after
 * the slot pool is exhausted still creates a real team with a real code — that case is designed
 * for, because forty slots and sixty teams is a thing that happens — and keying on the claim
 * would have left exactly those teams never sent theirs.
 *
 * It also keeps the noise out without a special case. An unclaimed slot holds no code, and
 * neither do the calibration reference rows, so both fall out of the join rather than arriving
 * as sixty-four rows an organiser has to read past. Issuing a code to a team that has none is a
 * different activity, on the same screen.
 */
async function registeredTeams(): Promise<Row[]> {
  const res = await query<Row>(
    `SELECT t.team_id, t.display_name, t.contact_email, t.contact_discord_user_id,
            a.token_id,
            EXISTS (SELECT 1 FROM token_delivery d
                     WHERE d.team_id = t.team_id AND d.status = 'SENT') AS sent
       FROM team t
       JOIN access_token a
              ON a.team_id = t.team_id AND a.kind = 'SUBMISSION'
             AND a.revoked_at IS NULL
             AND (a.expires_at IS NULL OR a.expires_at > now())
      ORDER BY length(t.display_name), t.display_name`)
  return res.rows
}

function classify(row: Row): HandoutRow {
  const base = {
    teamId: Number(row.team_id), teamName: row.display_name,
    contactEmail: row.contact_email,
  }
  if (row.sent) {
    return { ...base, state: 'SENT', detail: 'Already sent its code. Not sent again.' }
  }
  if (row.token_id === null) {
    // Unreachable through `registeredTeams`, which joins on a live token. Kept because the
    // classifier is the thing a future caller will reuse, and a silent send with no code is
    // worse than a row saying so.
    return {
      ...base, state: 'BLOCKED',
      detail: 'Holds no working code. Issue one from the intake screen first.',
    }
  }
  if (row.contact_email.trim() === '') {
    return {
      ...base, state: 'BLOCKED',
      detail: 'No contact address on this team, so there is nowhere to send it.',
    }
  }
  return { ...base, state: 'WAITING', detail: null }
}

export async function handOutCodes(input: {
  confirm: boolean
  actor: string
}): Promise<HandoutPlan> {
  const teams = await registeredTeams()
  const rows = teams.map(classify)
  const waiting = teams.filter((t) => classify(t).state === 'WAITING')

  const summarise = (report: DeliveryReport | null): HandoutPlan => ({
    rows,
    summary: {
      total: rows.length,
      waiting: rows.filter((r) => r.state === 'WAITING').length,
      alreadySent: rows.filter((r) => r.state === 'SENT').length,
      blocked: rows.filter((r) => r.state === 'BLOCKED').length,
    },
    report,
  })

  if (!input.confirm || waiting.length === 0) return summarise(null)

  const deliverables: Deliverable[] = []
  for (const team of waiting) {
    const reveal = await revealSubmissionToken(Number(team.token_id), input.actor)
    if (!reveal.available) {
      // Turned into a blocked row rather than thrown: one unreadable code must not stop the
      // other forty-seven teams from getting theirs.
      const at = rows.findIndex((r) => r.teamId === Number(team.team_id))
      if (at >= 0) rows[at] = { ...rows[at]!, state: 'BLOCKED', detail: reveal.reason }
      continue
    }
    deliverables.push({
      teamId: Number(team.team_id), tokenId: Number(team.token_id),
      teamName: team.display_name, contactEmail: team.contact_email,
      discordUserId: team.contact_discord_user_id, token: reveal.token,
    })
  }

  if (deliverables.length === 0) return summarise(null)

  // Paced, one at a time. `prepareDelivery` takes the whole list, so the gap goes between calls.
  const outcomes: DeliveryReport['outcomes'] = []
  const prepared: DeliveryReport['messages'] = []
  let provider = ''
  let sends = false
  for (const [i, item] of deliverables.entries()) {
    if (i > 0) await pause(SEND_GAP_MS)
    const report = await prepareDelivery({ deliverables: [item], actor: input.actor })
    outcomes.push(...report.outcomes)
    prepared.push(...report.messages)
    provider = report.provider
    sends = report.sends
  }

  await recordAudit({
    actor: input.actor, action: 'submissions.codes_handed_out',
    subjectType: 'access_token', subjectId: 'registered-teams',
    // Counts and team ids, never an address and never a code (P8.3).
    payload: {
      teams: deliverables.length,
      sent: outcomes.filter((o) => o.status === 'SENT').length,
      failed: outcomes.filter((o) => o.status === 'FAILED').length,
    },
  })

  log.info('submission codes handed out', {
    teams: deliverables.length,
    sent: outcomes.filter((o) => o.status === 'SENT').length,
  })

  return summarise({ provider, sends, outcomes, messages: prepared })
}
