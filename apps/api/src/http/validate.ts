/**
 * Boundary validation (P6.5).
 *
 * Every request body, query string and path parameter is parsed by an explicit zod schema at the
 * route layer before a service sees it. Services then trust in-process data and re-validate only
 * what arrives from outside the process — HTTP, jobs, events, model output, uploaded files.
 */
import type { FastifyRequest } from 'fastify'
import type { z, ZodTypeAny } from 'zod'
import { AppError } from '../lib/appError.js'

/**
 * Generic over the schema rather than over an output type `T`. Typing the parameter as
 * `ZodType<T>` forces input and output to unify, which silently makes every field carrying a
 * `.default()` read as optional at the call site — the defaulted value would then be typed
 * `number | undefined` despite always being present.
 */
function parse<S extends ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', `The ${what} did not match the expected shape.`, {
      details: {
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      },
    })
  }
  return result.data
}

export function body<S extends ZodTypeAny>(req: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, req.body, 'request body')
}

export function query<S extends ZodTypeAny>(req: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, req.query, 'query string')
}

export function params<S extends ZodTypeAny>(req: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, req.params, 'path parameters')
}
