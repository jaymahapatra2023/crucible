/**
 * Discord AND email, not Discord instead of email (E49-S01, migration 100).
 *
 * Wraps whichever mail adapter is configured. A recipient with a Discord identity gets the
 * message on both channels; one without gets email exactly as before, and nothing above the
 * port sees two providers.
 *
 * Why both rather than one with the other behind it: neither channel is reliable enough alone.
 * A DM needs the person to have joined the event server and to permit DMs from its members, and
 * that is their setting, not ours. An address can be mistyped on a roster, or sit in a spam
 * folder until Monday. The message that matters most — a team's submission code — is worth
 * sending twice, and `enforce_nonce` on the Discord side plus the idempotency key on the mail
 * side mean a retry of the pair is still one message in each place.
 *
 * The two sends are independent. A refused DM must not cost the team their email, so neither
 * result is allowed to throw past the other, and the outcome names what did and did not arrive.
 */
import { createLogger } from '../../../lib/logger.js'
import type {
  DeliveryChannel, MailMessage, MailProvider, MailResult,
} from '../../../lib/ports/mailPort.js'
import { isEnabled } from '../../platform/services/configService.js'
import { DiscordSendError, discordConfigured } from '../../../lib/discord/discordClient.js'
import { sendDiscordDm } from '../../../lib/discord/discordApi.js'

const log = createLogger('submissions', 'discordDelivery')

/** Why a send did not happen, in words an organiser can act on. Never a stack, never a token. */
const reasonOf = (err: unknown): string =>
  err instanceof DiscordSendError ? err.message
    : err instanceof Error ? err.message
      : 'could not be reached'

export function withBothChannels(base: MailProvider): MailProvider {
  return {
    name: `${base.name}+discord`,
    sends: true,

    async send(message: MailMessage): Promise<MailResult> {
      const id = message.discordUserId
      if (!id || !discordConfigured() || !(await isEnabled('feature.notify.discord'))) {
        return { channel: 'email', ...(await base.send(message)) }
      }

      // Settled, not raced: both are attempted whatever either one does.
      const [dm, email] = await Promise.allSettled([
        sendDiscordDm({ ...message, discordUserId: id }),
        base.send(message),
      ])

      return combine(dm, email)
    },
  }
}

function combine(
  dm: PromiseSettledResult<MailResult>,
  email: PromiseSettledResult<MailResult>,
): MailResult {
  const dmOk = dm.status === 'fulfilled' && dm.value.delivered
  const emailOk = email.status === 'fulfilled' && email.value.delivered

  // Both refused. Thrown, so the caller records a FAILED delivery exactly as it always has.
  if (!dmOk && email.status === 'rejected') {
    log.warn('neither channel carried the message', {
      discord: dm.status === 'rejected' ? reasonOf(dm.reason) : 'did not deliver',
    })
    throw email.reason
  }

  const missed = whatMissed(dm, email, dmOk, emailOk)
  if (missed !== null) log.info('one channel of two did not carry the message', { missed })

  const channel: DeliveryChannel = dmOk && emailOk ? 'both' : dmOk ? 'discord' : 'email'
  // The email result is the record when email ran at all: it carries the provider's own id and
  // the PREPARED-versus-SENT distinction the panel reads.
  const kept = email.status === 'fulfilled' ? email.value : null

  return {
    delivered: dmOk || emailOk,
    channel,
    detail: describe(channel, dmOk, kept),
    ...(missed !== null && { fallbackReason: missed }),
    ...(kept?.providerRef !== undefined && { providerRef: kept.providerRef }),
  }
}

function describe(channel: DeliveryChannel, dmOk: boolean, kept: MailResult | null): string {
  if (channel === 'both') return `Sent by Discord DM and email. ${kept?.detail ?? ''}`.trim()
  if (channel === 'discord') return 'Sent by Discord DM; email did not go.'
  return dmOk ? (kept?.detail ?? 'Sent by email.')
    : `Discord did not go — ${kept?.detail ?? 'email attempted.'}`
}

/**
 * Which half did not arrive, in a sentence. Null when both did.
 *
 * Separate from `combine` so neither has to be read with the other in mind: this one decides
 * what to SAY, that one decides what was delivered.
 */
function whatMissed(
  dm: PromiseSettledResult<MailResult>,
  email: PromiseSettledResult<MailResult>,
  dmOk: boolean,
  emailOk: boolean,
): string | null {
  if (dmOk && emailOk) return null
  if (dm.status === 'rejected') return `Discord: ${reasonOf(dm.reason)}`
  if (email.status === 'rejected') return `Email: ${reasonOf(email.reason)}`
  return dmOk ? 'Email did not deliver.' : 'Discord did not deliver.'
}
