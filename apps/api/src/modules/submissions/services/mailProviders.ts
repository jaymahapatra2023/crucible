/**
 * The mail adapters, and which one this machine uses (P1.5 clause 3, P12.2).
 *
 * One dispatcher on the provider axis, like `providerRegistry` for models. Adding a real sender
 * is one strategy object plus one line in `PROVIDERS` — there is no second lookup table to keep
 * in step.
 */
import { createLogger } from '../../../lib/logger.js'
import { loadEnv } from '../../../config/env.js'
import { registerMailProvider, type MailProvider } from '../../../lib/ports/mailPort.js'
import { resendProvider } from './resendProvider.js'
import { smtpProvider } from './smtpProvider.js'
import { withBothChannels } from './discordDelivery.js'
import { discordConfigured } from '../../../lib/discord/discordClient.js'

const log = createLogger('submissions', 'mail')

/**
 * Composes a real message and transmits nothing (E34).
 *
 * Not a stub, and not a thing to be replaced before the event: an organiser with forty addresses
 * and a mail-merge is a working delivery route, and one that this records honestly. What it
 * refuses to do is claim the message was sent.
 *
 * The composed body is returned to the caller rather than stored, because the body contains the
 * token. The plaintext exists for one moment by design (P8.3) and writing it into a delivery
 * record would be a second permanent copy of the credential.
 */
const recording: MailProvider = {
  name: 'record',
  sends: false,
  async send(message) {
    // The address and the body are deliberately absent from this line (P8.3). What is useful
    // operationally is that composition happened at all.
    log.info('message composed, not sent', { subject: message.subject })
    return {
      delivered: false,
      detail: 'Composed and recorded. No mail provider is configured, so nothing was sent — '
        + 'download the messages and send them yourself.',
    }
  },
}

const PROVIDERS: Record<string, MailProvider> = {
  record: recording,
  // Chosen with MAIL_PROVIDER=resend; env.ts refuses to boot without its key and sender.
  resend: resendProvider,
  // Chosen with MAIL_PROVIDER=smtp, for an event with a mailbox but no domain of its own.
  smtp: smtpProvider,
}

/**
 * Install the adapter this machine is configured for.
 *
 * Defaults to the recording adapter rather than failing to boot. A missing mail configuration
 * must not stop an evaluation platform from starting: everything else it does is unaffected, and
 * the delivery surface says plainly that nothing will be transmitted.
 */
export function installMailProvider(): void {
  const env = loadEnv()
  const chosen = PROVIDERS[env.MAIL_PROVIDER]
  if (!chosen) {
    log.warn('unknown mail provider; falling back to recording', { asked: env.MAIL_PROVIDER })
    registerMailProvider(recording)
    return
  }
  // Discord AND email (migration 100): only when a bot is configured, so a deployment
  // without one is exactly the deployment it was.
  if (discordConfigured()) {
    log.info('discord delivery configured; messages go by DM and email', { mail: chosen.name })
    registerMailProvider(withBothChannels(chosen))
    return
  }
  registerMailProvider(chosen)
}

export const RECORDING_PROVIDER = recording
