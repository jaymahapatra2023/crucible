/**
 * Correlation scope per request (P9.2).
 *
 * Every request runs inside an AsyncLocalStorage scope, so the logger, the DB layer and the LLM
 * gateway all stamp the same id without any of them being handed it explicitly.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { newCorrelationId, withCorrelation } from '../lib/correlation.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('platform', 'http')

const HEADER = 'x-request-id'

export function registerCorrelation(app: FastifyInstance): void {
  // onRequest runs the rest of the lifecycle inside the scope by wrapping `done`.
  app.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const incoming = req.headers[HEADER]
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200
        ? incoming
        : newCorrelationId()

    reply.header(HEADER, correlationId)
    withCorrelation({ correlationId }, done)
  })

  app.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    log.info('request', {
      method: req.method,
      path: req.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    })
    done()
  })
}
