import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordAudit, registerAuditPort, resetAuditPort } from './auditPort.js'
import { setLogSink } from '../logger.js'

afterEach(() => {
  resetAuditPort()
  setLogSink(null)
})

describe('audit port (P1.3, ADR 0002)', () => {
  it('delegates to the registered implementation', async () => {
    const record = vi.fn(async () => undefined)
    registerAuditPort({ record })
    await recordAudit({ actor: 'a@x.test', action: 'rubric.frozen', subjectType: 'rubric', subjectId: '1' })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rubric.frozen' }))
  })

  it('warns rather than throwing when no implementation is registered', async () => {
    const lines: Record<string, unknown>[] = []
    setLogSink((l) => lines.push(l))
    await expect(
      recordAudit({ actor: 'a', action: 'x.y', subjectType: 't', subjectId: '1' }),
    ).resolves.toBeUndefined()
    expect(lines.some((l) => String(l['msg']).includes('no audit port registered'))).toBe(true)
  })

  it('never lets an audit failure fail the action being audited', async () => {
    const lines: Record<string, unknown>[] = []
    setLogSink((l) => lines.push(l))
    registerAuditPort({ record: async () => { throw new Error('database is down') } })

    await expect(
      recordAudit({ actor: 'a', action: 'shortlist.finalised', subjectType: 's', subjectId: '1' }),
    ).resolves.toBeUndefined()
    expect(lines.some((l) => l['msg'] === 'audit write failed')).toBe(true)
  })

  it('a dropped event is logged loudly, never silently', async () => {
    const lines: Record<string, unknown>[] = []
    setLogSink((l) => lines.push(l))
    await recordAudit({ actor: 'a', action: 'x.y', subjectType: 't', subjectId: '9' })
    expect(lines[0]!['level']).toBe('warn')
    expect(lines[0]!['subjectId']).toBe('9')
  })
})
