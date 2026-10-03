/**
 * Outbound mail (E29-S02, E34).
 *
 * One interface, one adapter at a time, chosen at boot. Swapping Resend for SMTP is a new file
 * and one line in the registry — nothing above this line knows which is in use.
 *
 * **An unregistered port throws.** Sending is something an operator explicitly asked for, and a
 * silent no-op would report "delivery prepared" for forty teams that were never contacted. That
 * is the failure this whole table exists to make impossible, so it must not be reachable through
 * a missing wire.
 *
 * `sends` is the honest distinction between an adapter that transmits and one that does not. The
 * placeholder composes exactly what a real one would and hands it back instead — so the whole
 * path is exercised, the delivery record says `PREPARED` rather than `SENT`, and the operator
 * has the text to send themselves.
 */
import { createLogger } from '../logger.js'

const log = createLogger('platform', 'mailPort')

export interface MailMessage {
  to: string
  /**
   * Further addresses that get the SAME message, as copies.
   *
   * One message to a whole team rather than one per member. A team of eight was eight emails
   * carrying identical text, and at forty-eight teams that is several hundred messages through
   * a relay with a daily cap — the volume, not the content, was the problem. A copy list makes
   * it one message per team.
   *
   * Everyone on it can see the others, which is wanted here: these are teammates who already
   * know each other. It is NOT a way to mail strangers in bulk.
   */
  copyTo?: readonly string[]
  subject: string
  body: string
  /**
   * Names THIS message, stably, across retries (E43).
   *
   * A transmitting adapter hands it to the provider so a retry after a timeout returns the
   * original outcome instead of sending twice. Every message Crucible sends has a natural one —
   * `token-issued/<tokenId>`, `registration/<linkId>` — so it is required rather than optional:
   * the one message without a key is the one that gets delivered twice.
   */
  idempotencyKey: string
  /**
   * The recipient's Discord user id, when we have one (E49). An adapter that can DM sends to
   * BOTH this and `to`; every other adapter ignores it.
   */
  discordUserId?: string | null
}

/**
 * Which channels carried a message.
 *
 * 'both' is the ordinary outcome for a recipient with a Discord identity (migration 100). The
 * single-channel values are kept apart because what an organiser would do next differs: 'email'
 * means no DM was possible or Discord refused one, 'discord' means the mail relay failed.
 */
export type DeliveryChannel = 'email' | 'discord' | 'both'

export interface MailResult {
  /** Whether the message actually left this machine, by at least one channel. */
  delivered: boolean
  /** Which channel or channels carried it. Absent means email — the adapters that predate E49. */
  channel?: DeliveryChannel
  /**
   * Why a channel that was attempted did not carry it, when another one did (E49).
   *
   * Set when the message got through but not everywhere it was meant to: a DM refused while the
   * email went, or the relay failed while the DM went. A partial delivery that read as a clean
   * success would hide the half that needs fixing before the next message.
   */
  fallbackReason?: string
  /** What happened, in a sentence an organiser can act on. Never carries a credential. */
  detail: string
  /** The provider's own id for the message, when it gave one. For "did it go?" questions. */
  providerRef?: string
}

export interface MailProvider {
  readonly name: string
  /** False for an adapter that composes but does not transmit. */
  readonly sends: boolean
  send(message: MailMessage): Promise<MailResult>
}

const NOT_REGISTERED =
  'No mail provider is registered, so nothing can be sent. This is a wiring fault at boot, not a '
  + 'problem with the teams or their addresses.'

const unregistered: MailProvider = {
  name: 'none',
  sends: false,
  async send() {
    log.error('mail provider not registered')
    throw new Error(NOT_REGISTERED)
  },
}

let impl: MailProvider = unregistered

export function registerMailProvider(provider: MailProvider): void {
  impl = provider
  log.info('mail provider registered', { provider: provider.name, sends: provider.sends })
}

/** Test seam — restores the unregistered provider. */
export function resetMailProvider(): void {
  impl = unregistered
}

export const mail = (): MailProvider => impl
