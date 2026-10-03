/**
 * A participant's Discord identity, resolved where it can be checked (E49-S02).
 *
 * A username is what people know; a user id is what a DM needs. The event server is the one
 * place the two meet: a member search there returns the id for an exact username, and a
 * username it cannot find is a person the bot cannot DM. So resolution happens at the point of
 * entry — the People tab, or the registration form — and the outcome is told to whoever typed
 * it, rather than discovered on the night as a DM nobody received.
 *
 * Without a bot configured, the username is kept as given and the id stays null; everything
 * downstream falls back to email exactly as before.
 */
import { discordConfigured } from '../../../lib/discord/discordClient.js'
import { resolveMember } from '../../../lib/discord/discordApi.js'
import { getString } from '../../platform/services/configService.js'

export interface DiscordResolution {
  username: string | null
  userId: string | null
  /** What to tell the person who typed it. Null when nothing needs saying. */
  note: string | null
  found: boolean
}

export async function resolveDiscordUsername(raw: string | null | undefined): Promise<DiscordResolution> {
  const username = (raw ?? '').trim().replace(/^@/, '')
  if (username === '') return { username: null, userId: null, note: null, found: false }
  if (!discordConfigured()) {
    return {
      username, userId: null, found: false,
      note: 'Kept as typed. Discord delivery is not configured on this deployment, so codes go by email.',
    }
  }
  const lookup = await resolveMember(username)
  if (lookup.found) {
    return { username, userId: lookup.userId, found: true, note: `Found in the event server as ${lookup.displayName}.` }
  }
  const invite = (await getString('event.discord_invite_url')).trim()
  const join = lookup.reason === 'NOT_IN_SERVER'
    ? (invite === '' ? ' Join the event server first — ask an organiser for the invite.' : ` Join the event server first: ${invite}`)
    : ''
  return { username, userId: null, found: false, note: `${lookup.message}${join}` }
}
