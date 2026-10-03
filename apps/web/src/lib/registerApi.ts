/**
 * Participants registering their own teams (E44).
 *
 * Every call is anonymous: the link in the URL is the credential, verified server-side at its
 * mount point. Nothing here ever receives a list of participants or teams, and nothing here ever
 * receives a submission token — the server confirms it was EMAILED and stops there.
 */
import { getPublic, postPublic } from './apiClient.js'

export interface StartOutcome {
  status: 'SENT' | 'NOT_ON_ROSTER' | 'ALREADY_ON_TEAM' | 'MAIL_FAILED'
  message: string
  teamName?: string
}

export interface LinkScope {
  /** The registrant's OWN name — the only participant this ever carries. */
  registrantName: string
  registrantEmail: string
  bounds: { min: number; max: number }
  expiresAt: string
  /** Whether a Discord username can be checked and used for the code (E49). */
  discord: { enabled: boolean; inviteUrl: string }
}

export interface NameCheck {
  ok: boolean
  message: string
}

export interface LookupOutcome {
  found: boolean
  participantId?: number
  fullName?: string
  message: string
}

export interface ConfirmOutcome {
  teamId: number
  displayName: string
  memberCount: number
  /** Whether the code reached the address. Never the code itself. */
  tokenEmailed: boolean
  emailedTo: string
  /** What carried the code (migration 100): both channels, one of them, or nothing yet. */
  tokenSentVia: 'discord' | 'email' | 'both' | null
  /** Why a channel that was tried did not carry it. */
  discordNote: string | null
  /** One sentence per teammate Discord username that could not be used. */
  memberDiscordNotes: string[]
  message: string
}

export interface DiscordCheck {
  found: boolean
  displayName: string | null
  message: string
}

const scoped = (link: string, rest = '') => `/register/${encodeURIComponent(link)}${rest}`

export const startRegistration = (email: string) =>
  postPublic<StartOutcome>('/register/start', { email })

export const getLinkScope = (link: string) => getPublic<LinkScope>(scoped(link))

export const checkName = (link: string, name: string) =>
  getPublic<NameCheck>(scoped(link, `/name?name=${encodeURIComponent(name)}`))

export const lookupTeammate = (link: string, email: string) =>
  postPublic<LookupOutcome>(scoped(link, '/lookup'), { email })

export const checkDiscord = (link: string, username: string) =>
  postPublic<DiscordCheck>(scoped(link, '/discord'), { username })

/** A Discord username a teammate gave, resolved server-side against the event server. */
export interface TeammateDiscord {
  participantId: number
  username: string
}

export const confirmRegistration = (
  link: string,
  plan: {
    displayName: string
    teammateIds: number[]
    discordUsername?: string | null
    teammateDiscord?: TeammateDiscord[]
  },
) => postPublic<ConfirmOutcome>(scoped(link, '/confirm'), plan)
