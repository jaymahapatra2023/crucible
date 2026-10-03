/**
 * Getting each team the token it needs to submit (E29-S02, E34).
 *
 * The shape of this is forced by one fact: **a token's plaintext exists for a single moment**,
 * inside the response to the request that issued it. `access_token` holds a hash (P8.3). So
 * delivery cannot be a job that runs later over stored credentials — there are none to run over.
 * It happens in the same act as issuing, or it happens by reissuing.
 *
 * That is why `prepare` takes the issued rows rather than reading them back, and why the composed
 * bodies are returned to the caller instead of being stored. Writing the message into the
 * delivery record would be a second, permanent copy of the credential the hashing existed to
 * prevent.
 *
 * **Nothing here is reachable from an evaluation path.** Scoring, ranking and the batch
 * orchestrator never call it; an evaluation that could send mail would make a scoring run's side
 * effects unpredictable.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { renderMail } from './mailTemplates.js'
import { deadlineWording } from './windowService.js'
import { redactString } from '../../../lib/redact.js'
import { getString } from '../../platform/services/configService.js'
import { listDeliveries, upsertDelivery, type DeliveryRow } from '../db/deliveryDb.js'
import { listTeams } from '../db/teamDb.js'
import type { DeliveryChannel } from '../../../lib/ports/mailPort.js'

const log = createLogger('submissions', 'delivery')

export interface Deliverable {
  teamId: number
  tokenId: number
  teamName: string
  contactEmail: string
  /** DM target, when the team gave one (E49). Email carries it otherwise, or after a refusal. */
  discordUserId?: string | null
  /** The plaintext, for this call only. Never stored, never logged. */
  token: string
}

export interface PreparedMessage {
  teamName: string
  to: string
  subject: string
  body: string
  idempotencyKey: string
  /** Recorded with the delivery so a rewording is traceable to who got which text. */
  templateVersion: number
}

export interface DeliveryOutcome {
  teamId: number
  teamName: string
  status: DeliveryRow['status']
  detail: string
}

export interface DeliveryReport {
  provider: string
  /** False for an adapter that composes but does not transmit. */
  sends: boolean
  outcomes: DeliveryOutcome[]
  /**
   * The composed messages, present only when the provider does not send.
   *
   * The single moment they exist, exactly like the tokens inside them. An operator downloads
   * these and mail-merges them; nothing here can produce them a second time.
   */
  messages: PreparedMessage[]
}

export async function prepareDelivery(input: {
  deliverables: readonly Deliverable[]
  actor: string
}): Promise<DeliveryReport> {
  const provider = mail()
  const submitUrl = await getString('event.submit_url')

  const outcomes: DeliveryOutcome[] = []
  const messages: PreparedMessage[] = []

  for (const item of input.deliverables) {
    if (item.contactEmail.trim() === '') {
      // Recorded as a failure against the team rather than skipped quietly: a team with no
      // address is exactly the silent gap this whole record exists to surface.
      outcomes.push({
        teamId: item.teamId, teamName: item.teamName, status: 'FAILED',
        detail: 'No contact address on this team, so nothing could be sent. Name a point of '
          + 'contact on the roster and reissue.',
      })
      await record({
        item, status: 'FAILED', provider: provider.name,
        lastError: 'no contact address', actor: input.actor,
      })
      continue
    }

    const message = await compose(item, submitUrl)
    let status: DeliveryRow['status'] = 'PREPARED'
    let detail: string

    try {
      const result = await provider.send({ ...message, discordUserId: item.discordUserId ?? null })
      status = result.delivered ? 'SENT' : 'PREPARED'
      detail = result.detail
      if (!result.delivered) messages.push(message)
      await record({
        item, status, provider: provider.name,
        // A refusal that fell back is not an error, but it is a fact the panel shows (E49).
        lastError: result.fallbackReason ?? null,
        providerRef: result.providerRef ?? null, templateVersion: message.templateVersion,
        channel: result.channel ?? 'email', actor: input.actor,
      })
    } catch (err) {
      status = 'FAILED'
      // Redacted: a provider's error text routinely quotes the credential it was handed (P8.3).
      detail = redactString(err instanceof Error ? err.message : 'The message could not be sent.')
      await record({
        item, status: 'FAILED', provider: provider.name, lastError: detail, actor: input.actor,
      })
    }

    outcomes.push({ teamId: item.teamId, teamName: item.teamName, status, detail })
  }

  await recordAudit({
    actor: input.actor, action: 'submissions.tokens_delivered', subjectType: 'access_token',
    subjectId: 'bulk',
    // Counts and ids only — no address, no token (P8.3).
    payload: {
      provider: provider.name,
      sent: outcomes.filter((o) => o.status === 'SENT').length,
      prepared: outcomes.filter((o) => o.status === 'PREPARED').length,
      failed: outcomes.filter((o) => o.status === 'FAILED').length,
    },
  })
  log.info('delivery prepared', {
    provider: provider.name, teams: outcomes.length,
    failed: outcomes.filter((o) => o.status === 'FAILED').length,
  })

  return { provider: provider.name, sends: provider.sends, outcomes, messages }
}

const record = (input: {
  item: Deliverable
  status: DeliveryRow['status']
  provider: string
  lastError: string | null
  providerRef?: string | null
  templateVersion?: number | null
  channel?: DeliveryChannel
  actor: string
}) => upsertDelivery({
  teamId: input.item.teamId, tokenId: input.item.tokenId, status: input.status,
  provider: input.provider, lastError: input.lastError,
  providerRef: input.providerRef ?? null, templateVersion: input.templateVersion ?? null,
  channel: input.channel ?? 'email', preparedBy: input.actor,
})

/**
 * The message a team receives, from the database template (E43-S02, P3.3).
 *
 * The wording used to live here. Moving it out means an organiser can correct a sentence forty
 * teams will read without a deploy, and the version that produced each message is recorded.
 */
async function compose(item: Deliverable, submitUrl: string): Promise<PreparedMessage> {
  const rendered = await renderMail('mail.token_issued', {
    team_name: item.teamName,
    token: item.token,
    submit_url: submitUrl.trim() === '' ? 'the submission page' : submitUrl.trim(),
    // Read from the window the system enforces, never typed in (migration 098).
    deadline: await deadlineWording(),
  })
  return {
    teamName: item.teamName,
    to: item.contactEmail,
    subject: rendered.subject,
    body: rendered.body,
    // Stable across retries, so a timeout can be retried without delivering twice (E43).
    idempotencyKey: `token-issued/${item.tokenId}`,
    templateVersion: rendered.templateVersion,
  }
}

/** Per-team delivery state, for the surface that has to show a team who cannot submit. */
export async function deliveryState(): Promise<Array<{
  teamId: number
  teamName: string
  contactEmail: string
  status: DeliveryRow['status'] | 'NONE'
  attempts: number
  lastError: string | null
  /** The provider's id, so "did it go?" is answerable against their record. */
  providerRef: string | null
  /** What carried the last attempt (E49), and whether the team has a Discord contact at all. */
  channel: DeliveryChannel | null
  hasDiscord: boolean
  preparedAt: Date | null
}>> {
  const [teams, deliveries] = await Promise.all([listTeams(), listDeliveries()])
  const byTeam = new Map<number, DeliveryRow>()
  for (const d of deliveries) {
    // Newest first from the query, so the first seen is the current one.
    if (!byTeam.has(d.teamId)) byTeam.set(d.teamId, d)
  }

  return teams.map((team) => {
    const found = byTeam.get(team.teamId)
    return {
      teamId: team.teamId,
      teamName: team.displayName,
      contactEmail: team.contactEmail,
      // NONE, never PREPARED: nothing was attempted, which is different from something failing.
      status: found?.status ?? 'NONE',
      attempts: found?.attempts ?? 0,
      channel: found?.channel ?? null,
      hasDiscord: team.contactDiscordUserId !== null,
      lastError: found?.lastError ?? null,
      providerRef: found?.providerRef ?? null,
      preparedAt: found?.preparedAt ?? null,
    }
  })
}

export function assertDeliverable(deliverables: readonly Deliverable[]): void {
  if (deliverables.length === 0) {
    throw new AppError('PRECONDITION_FAILED',
      'No tokens were issued in this request, so there is nothing to deliver. A token can only '
      + 'be delivered in the act that creates it — its plaintext is not stored.')
  }
}
