/**
 * The single place an error becomes an HTTP response (P6.2).
 *
 * Status is derived from the error code table, never chosen per handler, so "status codes are
 * semantically correct" is a property of the system rather than of each author's care. Internal
 * details never reach the client; they go to the structured log with the correlation id, and the
 * client gets the id so a support conversation can join the two (P9.2).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { fail, statusForCode, type ErrorCode } from '@crucible/contracts'
import { AppError } from '../lib/appError.js'
import { createLogger } from '../lib/logger.js'
import { currentCorrelationId } from '../lib/correlation.js'

const log = createLogger('platform', 'http')

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply
      .status(404)
      .send(fail('NOT_FOUND', `No route matches ${req.method} ${req.url}.`))
  })

  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = currentCorrelationId()

    if (err instanceof AppError) {
      if (err.status >= 500) log.error('request failed', { err, path: req.url })
      else log.warn('request rejected', { code: err.code, path: req.url, msg: err.message })
      reply.status(err.status).send(fail(err.code, err.message, err.details))
      return
    }

    if (err instanceof ZodError) {
      reply.status(400).send(
        fail('VALIDATION_FAILED', 'The request did not match the expected shape.', {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      )
      return
    }

    // Fastify's own validation and payload errors carry a statusCode.
    const status = (err as FastifyError).statusCode
    if (typeof status === 'number' && status < 500) {
      const code: ErrorCode =
        status === 413 ? 'PAYLOAD_TOO_LARGE'
        : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE'
        : status === 429 ? 'RATE_LIMITED'
        : 'MALFORMED_REQUEST'
      reply.status(status).send(fail(code, err.message))
      return
    }

    // Anything else is ours and is not described to the caller (P8.3, P8.5).
    log.error('unhandled error', { err, path: req.url, method: req.method })
    reply.status(statusForCode('INTERNAL_ERROR')).send(
      fail('INTERNAL_ERROR', 'An unexpected error occurred.', { correlationId }),
    )
  })
}
