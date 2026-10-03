/**
 * Chasing teams before the deadline (E50): who is not there yet, and telling them.
 */
import { get, post } from './apiClient.js'

export interface TeamToChase {
  teamId: number
  teamName: string
  contactEmail: string
  hasDiscord: boolean
  kind: 'NOT_SUBMITTED' | 'PROBLEMS'
  situation: string
  lastReminder: {
    reminderId: number; kind: 'NOT_SUBMITTED' | 'PROBLEMS'; status: 'SENT' | 'PREPARED' | 'FAILED'
    channel: 'email' | 'discord' | 'both'; detail: string | null; sentAt: string
  } | null
}

export const getChaseList = () => get<TeamToChase[]>('/submissions/reminders')
export const sendReminders = (teamIds?: number[]) =>
  post<unknown>('/submissions/reminders', teamIds ? { teamIds } : {})
