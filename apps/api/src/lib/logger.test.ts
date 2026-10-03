import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, setLogLevel, setLogSink } from './logger.js'
import { withCorrelation } from './correlation.js'
import { clearSecrets, REDACTED, registerSecrets } from './redact.js'

let lines: Record<string, unknown>[] = []

beforeEach(() => {
  lines = []
  setLogSink((l) => lines.push(l))
  setLogLevel('debug')
})

afterEach(() => {
  setLogSink(null)
  setLogLevel('info')
  clearSecrets()
})

describe('structured logging (P9.1)', () => {
  it('emits one JSON object carrying the required fields', () => {
    createLogger('platform', 'db').info('query ran')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'info', module: 'platform', service: 'db', msg: 'query ran',
    })
    expect(lines[0]!['timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('includes domain context from the ambient correlation scope (P9.2)', () => {
    withCorrelation({ correlationId: 'abc-123', actor: 'op@x.test', runId: '7' }, () => {
      createLogger('batch', 'orchestrator').info('stage done')
    })
    expect(lines[0]).toMatchObject({ correlationId: 'abc-123', actor: 'op@x.test', runId: '7' })
  })

  it('omits correlation fields outside a scope rather than emitting nulls', () => {
    createLogger('platform', 'boot').info('starting')
    expect(lines[0]).not.toHaveProperty('correlationId')
  })

  it('respects the level threshold', () => {
    setLogLevel('warn')
    const log = createLogger('m', 's')
    log.debug('no'); log.info('no'); log.warn('yes'); log.error('yes')
    expect(lines.map((l) => l['level'])).toEqual(['warn', 'error'])
  })

  it('redacts a registered secret anywhere in the line (P8.3)', () => {
    registerSecrets(['super-secret-token-value'])
    createLogger('llm', 'gateway').error('call failed', {
      err: new Error('auth failed for super-secret-token-value'),
      apiKey: 'super-secret-token-value',
    })
    const serialised = JSON.stringify(lines[0])
    expect(serialised).not.toContain('super-secret-token-value')
    expect(serialised).toContain(REDACTED)
  })

  it('drops undefined fields instead of emitting them', () => {
    createLogger('m', 's').info('x', { present: 1, absent: undefined })
    expect(lines[0]).toHaveProperty('present')
    expect(lines[0]).not.toHaveProperty('absent')
  })

  it('carries callKey, which P3.2 requires on every gateway line', () => {
    createLogger('llm', 'gateway').info('llm call ok', { callKey: 'scoring.criterion' })
    expect(lines[0]!['callKey']).toBe('scoring.criterion')
  })

  it('derives a child logger with a narrower service name', () => {
    createLogger('scans', 'scanner').child('clone').info('cloned')
    expect(lines[0]!['service']).toBe('scanner.clone')
  })

  it('never throws on an unserialisable field', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => createLogger('m', 's').info('x', { circular })).not.toThrow()
  })
})
