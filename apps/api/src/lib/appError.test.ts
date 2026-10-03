import { describe, expect, it } from 'vitest'
import { AppError, conflict, errorMessage, forbidden, isAppError, notFound, validationFailed } from './appError.js'

describe('AppError', () => {
  it('derives the HTTP status from the code, so no handler picks one by hand (P6.2)', () => {
    expect(new AppError('NOT_FOUND', 'x').status).toBe(404)
    expect(new AppError('FORBIDDEN', 'x').status).toBe(403)
    expect(new AppError('RATE_LIMITED', 'x').status).toBe(429)
    expect(new AppError('INTERNAL_ERROR', 'x').status).toBe(500)
    expect(new AppError('RUBRIC_NOT_FROZEN', 'x').status).toBe(422)
  })

  it('marks transient codes retryable by default', () => {
    expect(new AppError('RATE_LIMITED', 'x').retryable).toBe(true)
    expect(new AppError('UPSTREAM_UNAVAILABLE', 'x').retryable).toBe(true)
    expect(new AppError('TIMEOUT', 'x').retryable).toBe(true)
    expect(new AppError('VALIDATION_FAILED', 'x').retryable).toBe(false)
  })

  it('allows an explicit retryable override', () => {
    expect(new AppError('CONFLICT', 'x', { retryable: true }).retryable).toBe(true)
  })

  it('preserves a cause for the redactor to walk', () => {
    const cause = new Error('underlying')
    expect(new AppError('INTERNAL_ERROR', 'outer', { cause }).cause).toBe(cause)
  })

  it('carries details through to the response body', () => {
    expect(new AppError('VALIDATION_FAILED', 'x', { details: { field: 'email' } }).details)
      .toEqual({ field: 'email' })
  })

  it('is identifiable via isAppError', () => {
    expect(isAppError(new AppError('NOT_FOUND', 'x'))).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError('x')).toBe(false)
  })
})

describe('convenience constructors', () => {
  it('notFound names the subject and its id', () => {
    expect(notFound('Run', '42').message).toBe("Run '42' was not found.")
    expect(notFound('Run').message).toBe('Run was not found.')
  })

  it('validationFailed, conflict and forbidden carry the right codes', () => {
    expect(validationFailed('bad').code).toBe('VALIDATION_FAILED')
    expect(conflict('clash').code).toBe('CONFLICT')
    expect(forbidden('no').code).toBe('FORBIDDEN')
  })
})

describe('errorMessage', () => {
  it('reads an Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })
  it('passes a string through', () => {
    expect(errorMessage('plain')).toBe('plain')
  })
  it('serialises a non-Error throw rather than printing [object Object]', () => {
    expect(errorMessage({ code: 7 })).toBe('{"code":7}')
  })
  it('never throws on an unserialisable value', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => errorMessage(circular)).not.toThrow()
  })
})
