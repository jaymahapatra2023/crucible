/**
 * What Crucible does with Discord (E49): DM a message to a member, and resolve a username to a
 * member of the event server.
 *
 * Idempotent across a retry: Discord's `nonce` with `enforce_nonce` dedupes a message sent twice
 * within its window, so a timeout after delivery does not produce two DMs. A body over the
 * per-message limit is split at line boundaries, never truncated.
 *
 * The username lookup is what registration uses: a username the bot cannot find in the event
 * server is a person the bot cannot DM, and the form says so then rather than on the night.
 */
import { createHash } from 'node:crypto'
import { createLogger } from '../logger.js'
import { loadEnv } from '../../config/env.js'
import type { MailMessage, MailResult } from '../ports/mailPort.js'
import { DiscordSendError, MAX_CONTENT, call, withRetries } from './discordClient.js'

const log = createLogger('platform', 'discord')

/** Split at line boundaries so nothing a team reads is cut mid-sentence. */
export function chunkContent(text: string, max = MAX_CONTENT): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`
    if (candidate.length > max && current !== '') {
      chunks.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** A stable numeric nonce ≤ 25 characters, from the idempotency key. */
const nonceFor = (key: string, part: number): string =>
  BigInt(`0x${createHash('sha256').update(`${key}#${part}`).digest('hex').slice(0, 16)}`).toString().slice(0, 25)

/** DM one message. Throws `DiscordSendError`; REJECTED means "fall back", the rest "give up". */
export async function sendDiscordDm(message: MailMessage & { discordUserId: string }): Promise<MailResult> {
  const channel = await withRetries('open dm', () =>
    call<{ id: string }>('/users/@me/channels', { method: 'POST', body: { recipient_id: message.discordUserId } }))

  const parts = chunkContent(`**${message.subject}**\n\n${message.body}`)
  let lastId: string | null = null
  for (const [i, content] of parts.entries()) {
    const posted = await withRetries('post message', () =>
      call<{ id: string }>(`/channels/${channel.id}/messages`, {
        method: 'POST',
        body: { content, nonce: nonceFor(message.idempotencyKey, i), enforce_nonce: true },
      }))
    lastId = posted.id
  }
  return {
    delivered: true, channel: 'discord',
    detail: `Sent by Discord DM${parts.length > 1 ? ` in ${parts.length} parts` : ''}.`,
    ...(lastId !== null && { providerRef: `discord:${lastId}` }),
  }
}

export type MemberLookup =
  | { found: true; userId: string; displayName: string }
  | { found: false; reason: 'NOT_IN_SERVER' | 'AMBIGUOUS' | 'UNAVAILABLE'; message: string }

/**
 * Resolve a username to a member of the event server (E49-S02). Exact match on username, or
 * failing that on display name — never a list, never a prefix search returned to the caller.
 */
export async function resolveMember(username: string): Promise<MemberLookup> {
  const env = loadEnv()
  const wanted = username.trim().replace(/^@/, '').toLowerCase()
  if (wanted === '') return { found: false, reason: 'NOT_IN_SERVER', message: 'Enter a Discord username.' }
  try {
    const members = await withRetries('member search', () =>
      call<Array<{ user: { id: string; username: string; global_name: string | null }; nick: string | null }>>(
        `/guilds/${env.DISCORD_GUILD_ID ?? ''}/members/search?query=${encodeURIComponent(wanted)}&limit=10`,
        { method: 'GET' }))
    const exact = members.filter((m) => m.user.username.toLowerCase() === wanted)
    const byName = exact.length > 0 ? exact : members.filter((m) =>
      (m.nick ?? '').toLowerCase() === wanted || (m.user.global_name ?? '').toLowerCase() === wanted)
    if (byName.length === 1) {
      const m = byName[0]!
      return { found: true, userId: m.user.id, displayName: m.nick ?? m.user.global_name ?? m.user.username }
    }
    if (byName.length > 1) {
      return { found: false, reason: 'AMBIGUOUS', message: 'More than one member matches; use your exact Discord username.' }
    }
    return { found: false, reason: 'NOT_IN_SERVER', message: 'No member of the event server has that username.' }
  } catch (err) {
    log.warn('discord member lookup failed', { kind: err instanceof DiscordSendError ? err.kind : 'unknown' })
    return { found: false, reason: 'UNAVAILABLE', message: 'Discord could not be checked just now; you can add it later or continue by email.' }
  }
}
