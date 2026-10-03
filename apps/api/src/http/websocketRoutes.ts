/**
 * WebSocket endpoint for live progress (P5.1).
 *
 * Auth note: browsers cannot set an Authorization header on a WebSocket handshake, so the token
 * arrives as a query parameter and is verified here explicitly. This is an alternate
 * authentication factor documented at its mount point, which is what P8.1 requires — not an
 * unauthenticated route.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { loadEnv } from '../config/env.js'
import { verifyToken } from '../lib/jwt.js'
import { createLogger } from '../lib/logger.js'
import { publish, subscribe, unsubscribeAll } from './progressHub.js'

const log = createLogger('platform', 'websocket')

const connectQuery = z.object({
  token: z.string().min(1),
  topic: z.string().regex(/^run:\d+$/, 'topic must be run:<id>'),
})

export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  app.get('/ws/progress', { websocket: true }, (socket, req) => {
    const parsed = connectQuery.safeParse(req.query)
    if (!parsed.success) {
      socket.close(1008, 'token and topic query parameters are required')
      return
    }

    const auth = verifyToken(parsed.data.token, loadEnv().JWT_SECRET)
    if (!auth.ok) {
      log.warn('websocket token rejected', { reason: auth.reason })
      socket.close(1008, 'invalid token')
      return
    }

    const { topic } = parsed.data
    subscribe(topic, socket)
    log.info('websocket subscribed', { topic, actor: auth.claims.email })

    // Tell the client it is attached, so the UI can distinguish "connected, nothing yet" from
    // "not connected" — a distinction P5.7 requires the UI to be able to make.
    publish(topic, 'status', { subscribed: true })

    socket.on('close', () => {
      unsubscribeAll(socket)
      log.debug('websocket closed', { topic })
    })
    socket.on('error', (err: unknown) => {
      log.warn('websocket error', { err, topic })
      unsubscribeAll(socket)
    })
  })
}
