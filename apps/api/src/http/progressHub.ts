/**
 * Live progress over WebSocket (P5.1 — "real-time progress, never polling").
 *
 * Clients subscribe to a topic (`run:42`); publishers push stage transitions as they happen.
 * The hub holds no durable state: everything published here is already recorded in the run
 * ledger, so a client that reconnects reads current state from `GET /runs/:id` and resumes
 * receiving live updates. That is what makes E10-S05's "survives page reload" true without the
 * hub becoming in-process state that P11.4 forbids.
 */
import type { WebSocket } from '@fastify/websocket'
import { createLogger } from '../lib/logger.js'

const log = createLogger('platform', 'progressHub')

export interface ProgressMessage {
  topic: string
  /** `progress` carries position within a stage (E10-S05); `stage` carries one item's outcome. */
  type: 'stage' | 'progress' | 'status' | 'cost' | 'error'
  at: string
  payload: Record<string, unknown>
}

const subscribers = new Map<string, Set<WebSocket>>()

export function subscribe(topic: string, socket: WebSocket): void {
  let set = subscribers.get(topic)
  if (!set) {
    set = new Set()
    subscribers.set(topic, set)
  }
  set.add(socket)
  log.debug('subscribed', { topic, subscribers: set.size })
}

export function unsubscribe(topic: string, socket: WebSocket): void {
  const set = subscribers.get(topic)
  if (!set) return
  set.delete(socket)
  if (set.size === 0) subscribers.delete(topic)
}

export function unsubscribeAll(socket: WebSocket): void {
  for (const [topic, set] of subscribers) {
    set.delete(socket)
    if (set.size === 0) subscribers.delete(topic)
  }
}

/** Publish to a topic. Never throws — a dead socket must not fail the work being reported. */
export function publish(topic: string, type: ProgressMessage['type'], payload: Record<string, unknown>): void {
  const set = subscribers.get(topic)
  if (!set || set.size === 0) return

  const message: ProgressMessage = { topic, type, at: new Date().toISOString(), payload }
  const text = JSON.stringify(message)

  for (const socket of set) {
    try {
      if (socket.readyState === 1) socket.send(text)
    } catch (err) {
      log.warn('progress publish failed for one subscriber', { err, topic })
    }
  }
}

export const runTopic = (runId: number): string => `run:${runId}`

/** Test seam. */
export function resetHub(): void {
  subscribers.clear()
}

export function subscriberCount(topic: string): number {
  return subscribers.get(topic)?.size ?? 0
}
