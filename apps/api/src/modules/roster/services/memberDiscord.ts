/**
 * Every member's Discord identity, captured at registration (migration 100).
 *
 * Until now only the person who registered could give a Discord username, so only they could be
 * DMed, and the rest of the team got email alone. That is backwards: the member most likely to
 * be at the keyboard at 11pm is whoever is still awake, and the code has to reach all of them by
 * both routes.
 *
 * Resolved HERE against the event server, never trusted from the request body — the same rule as
 * the registrant's own (E49-S02). A body that named somebody else's user id would otherwise send
 * this team's submission code to a stranger. A username is what people know; a user id is what a
 * DM needs, and the event server is the only place the two meet.
 *
 * Written to the participant row, so it is theirs rather than this team's: reminders, preflight
 * notices and next year's event all read the same column, and nobody has to type it twice.
 */
import { createLogger } from '../../../lib/logger.js'
import { updateParticipant } from '../db/rosterDb.js'
import { resolveDiscordUsername } from './discordIdentity.js'

const log = createLogger('roster', 'memberDiscord')

export interface MemberDiscordInput {
  participantId: number
  username: string
}

export interface MemberDiscordOutcome {
  /** How many members now have an id a DM can be sent to. */
  resolved: number
  /** One sentence per username that could not be used, naming it. Shown to the registrant. */
  notes: string[]
}

/**
 * Resolve and store a Discord username for each member who gave one.
 *
 * Outside the registration transaction, deliberately. These are facts about people, not about
 * the team: if the registration then fails on the team name, the participant having told us
 * their Discord username is still true and is worth keeping. `updateParticipant` takes no client
 * for the same reason — it was never part of anybody's transaction.
 *
 * Best-effort per member. One unresolvable username must not cost the other five their DMs.
 */
export async function applyMemberDiscord(
  input: readonly MemberDiscordInput[],
  names: ReadonlyMap<number, string>,
): Promise<MemberDiscordOutcome> {
  const outcome: MemberDiscordOutcome = { resolved: 0, notes: [] }

  for (const entry of input) {
    const typed = entry.username.trim()
    if (typed === '') continue
    const who = names.get(entry.participantId) ?? `participant ${entry.participantId}`

    try {
      const resolved = await resolveDiscordUsername(typed)
      // Stored as typed either way: an organiser can see what the person meant and fix it,
      // which is impossible if an unmatched username is simply discarded.
      await updateParticipant({
        participantId: entry.participantId,
        discordUsername: resolved.username,
        discordUserId: resolved.userId,
      })
      if (resolved.found) {
        outcome.resolved += 1
      } else {
        outcome.notes.push(`${who} (${typed}): ${resolved.note ?? 'could not be matched.'}`)
      }
    } catch (err) {
      // No username in the log line (E49-S02 acceptance 5); the note on screen names it.
      log.warn('member discord username could not be resolved', {
        participantId: entry.participantId,
        detail: err instanceof Error ? err.message : 'unknown',
      })
      outcome.notes.push(`${who} (${typed}): could not be checked just now; email will be used.`)
    }
  }

  if (input.length > 0) {
    log.info('member discord identities applied', {
      given: input.length, resolved: outcome.resolved, unresolved: outcome.notes.length,
    })
  }
  return outcome
}
