/**
 * Mail templates and the real adapter, end to end through the port (E43).
 *
 * Two properties carry the epic. The token appears in exactly ONE template, ever — a second
 * template containing `{{token}}` is a second place a credential can leak. And a delivery is
 * recorded `SENT` only when the provider confirmed it, with the provider's own reference, so
 * "did it go?" can be answered against their record rather than ours alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { teams } from '../../src/lib/ports/teamPort.js'
import { registerMailProvider } from '../../src/lib/ports/mailPort.js'
import { resendProvider, resetResendBreaker } from '../../src/modules/submissions/services/resendProvider.js'
import { renderMail } from '../../src/modules/submissions/services/mailTemplates.js'
import { listMailTemplates } from '../../src/modules/submissions/db/mailTemplateDb.js'
import { issueForTeamsWithout, deliverIssued } from '../../src/modules/submissions/services/bulkTokens.js'
import { resetEnvCache } from '../../src/config/env.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { setLogLevel, setLogSink } from '../../src/lib/logger.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'mail' }, fn)

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  installTeamPort()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetEnvCache()
})

describe('rendering (E43-S02)', () => {
  it('renders the token message from the database, subject and body', async () => {
    const mail = await renderMail('mail.token_issued', {
      team_name: 'Night Shift', token: 'crs_abc123', submit_url: 'https://crucible.example/submit',
      deadline: 'Sunday, 4 October 2026 at 09:00 (Eastern)',
    })

    expect(mail.subject).toBe('Night Shift — your submission code')
    expect(mail.body).toContain('crs_abc123')
    expect(mail.body).toContain('https://crucible.example/submit')
    // The version that produced a message is recorded. Read from the database rather than
    // written here as a literal: every migration that edits this template bumps it, and a
    // literal turns an intended wording change into a failing test about nothing.
    const active = (await listMailTemplates()).find((t) => t.mailKey === 'mail.token_issued' && t.active)
    expect(mail.templateVersion).toBe(active!.version)
  })

  it('says what happened, what to do, and who to ask — in that order', async () => {
    const { body } = await renderMail('mail.token_issued', {
      team_name: 'T', token: 'x', submit_url: 'u', deadline: 'the deadline',
    })
    const happened = body.indexOf('registered')
    const toDo = body.indexOf('What to do')
    const ask = body.indexOf('ask an organiser')
    expect(happened).toBeGreaterThan(-1)
    expect(toDo).toBeGreaterThan(happened)
    expect(ask).toBeGreaterThan(toDo)
  })

  it('REFUSES to render with a variable missing, naming it', async () => {
    await expect(renderMail('mail.token_issued', { team_name: 'T', token: 'x' }))
      .rejects.toThrow(/needs submit_url/)
  })

  it('refuses an unknown key rather than sending nothing', async () => {
    await expect(renderMail('mail.does_not_exist', {})).rejects.toThrow(/No active mail template/)
  })

  it('puts the token in exactly ONE template in use, ever', async () => {
    // Superseded versions keep their wording on purpose — what a team was sent has to be
    // reconstructable — so the property is about the templates actually in use.
    const carrying = (await listMailTemplates())
      .filter((t) => t.active)
      .filter((t) => t.body.includes('{{token}}') || t.subject.includes('{{token}}'))
      .map((t) => t.mailKey)
    expect(carrying).toEqual(['mail.token_issued'])
  })

  it('leaves no superseded version in use alongside its replacement', async () => {
    // One active version per key is what the reader relies on; a second would make "which
    // wording did they get" unanswerable.
    const byKey = new Map<string, number>()
    for (const t of (await listMailTemplates()).filter((x) => x.active)) {
      byKey.set(t.mailKey, (byKey.get(t.mailKey) ?? 0) + 1)
    }
    expect([...byKey.values()].every((n) => n === 1)).toBe(true)
  })
})

describe('sending through the real adapter (E43-S01)', () => {
  beforeEach(() => {
    vi.stubEnv('MAIL_PROVIDER', 'resend')
    vi.stubEnv('MAIL_API_KEY', 're_test_key_1234567890')
    vi.stubEnv('MAIL_FROM', 'crucible@example.test')
    resetEnvCache()
    resetResendBreaker()
    registerMailProvider(resendProvider)
  })

  it('records SENT with the provider reference only once the provider confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ id: 'msg_from_resend' }), { status: 200 })))
    await inScope(() => teams().create({
      displayName: 'Alpha', contactEmail: 'alpha@example.test', actor: ACTOR,
    }))

    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    expect(report.outcomes[0]?.status).toBe('SENT')
    expect(report.messages).toHaveLength(0)
    const row = await query<{ status: string; provider_ref: string | null; sent_at: Date | null }>(
      'SELECT status, provider_ref, sent_at FROM token_delivery')
    expect(row.rows[0]).toMatchObject({ status: 'SENT', provider_ref: 'msg_from_resend' })
    expect(row.rows[0]?.sent_at).not.toBeNull()
  })

  it('records FAILED with the reason REDACTED when the provider quotes the key back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Invalid API key: re_test_key_1234567890' }),
        { status: 401 })))
    await inScope(() => teams().create({
      displayName: 'Alpha', contactEmail: 'alpha@example.test', actor: ACTOR,
    }))

    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    expect(report.outcomes[0]?.status).toBe('FAILED')
    const stored = await query<{ last_error: string }>('SELECT last_error FROM token_delivery')
    expect(stored.rows[0]?.last_error).not.toContain('re_test_key_1234567890')
    expect(stored.rows[0]?.last_error).toContain('[REDACTED]')
  })

  it('sends the rendered template, with the delivery-keyed idempotency header', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await inScope(() => teams().create({
      displayName: 'Alpha', contactEmail: 'alpha@example.test', actor: ACTOR,
    }))
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    await inScope(() => deliverIssued(plan.rows, ACTOR))

    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1]
    const sent = JSON.parse(init.body as string) as { subject: string; text: string; to: string[] }
    expect(sent.subject).toBe('Alpha — your submission code')
    expect(sent.text).toContain(plan.rows[0]!.token!)
    expect(sent.to).toEqual(['alpha@example.test'])
    expect((init.headers as Record<string, string>)['idempotency-key'])
      .toBe(`token-issued/${plan.rows[0]!.tokenId}`)
  })
})

describe('what never reaches a log line (E43-S01 acceptance 6, P8.3)', () => {
  it('writes no address and no token to any log during a real-adapter send', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'resend')
    vi.stubEnv('MAIL_API_KEY', 're_test_key_1234567890')
    vi.stubEnv('MAIL_FROM', 'crucible@example.test')
    resetEnvCache()
    resetResendBreaker()
    registerMailProvider(resendProvider)
    // A 500 then a 200, so the retry path logs too — that is the path most likely to leak.
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response(JSON.stringify({ message: 'boom' }), { status: 500 })
        : new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
    }))
    const { setResendSleeper } = await import(
      '../../src/modules/submissions/services/resendProvider.js')
    setResendSleeper(async () => {})

    const lines: string[] = []
    // The harness runs at `error`, which would drop every info and warn line and make the
    // assertion below vacuous — the `lines.length > 0` guard caught exactly that.
    setLogLevel('info')
    setLogSink((line) => { lines.push(JSON.stringify(line)) })
    try {
      await inScope(() => teams().create({
        displayName: 'Alpha', contactEmail: 'alpha-secret@example.test', actor: ACTOR,
      }))
      const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
      await inScope(() => deliverIssued(plan.rows, ACTOR))

      const everything = lines.join('\n')
      expect(everything).not.toContain('alpha-secret@example.test')
      expect(everything).not.toContain(plan.rows[0]!.token!)
      expect(everything).not.toContain('re_test_key_1234567890')
      // And something WAS logged, or the assertion above proves nothing.
      expect(lines.length).toBeGreaterThan(0)
    } finally {
      setLogSink(null)
      setLogLevel('error')
    }
  })

  it('records which template version produced the message', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'resend')
    vi.stubEnv('MAIL_API_KEY', 're_test_key_1234567890')
    vi.stubEnv('MAIL_FROM', 'crucible@example.test')
    resetEnvCache()
    resetResendBreaker()
    registerMailProvider(resendProvider)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ id: 'x' }), { status: 200 })))
    await inScope(() => teams().create({
      displayName: 'Alpha', contactEmail: 'alpha@example.test', actor: ACTOR,
    }))
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    await inScope(() => deliverIssued(plan.rows, ACTOR))

    // Without this, "what did team X get?" after a rewording has no answer. The number is the
    // version actually in use, which rises as the wording is corrected — it is not a constant.
    const row = await query<{ template_version: number }>(
      'SELECT template_version FROM token_delivery')
    const active = await query<{ version: number }>(
      `SELECT version FROM mail_template WHERE mail_key = 'mail.token_issued' AND active`)
    expect(Number(row.rows[0]?.template_version)).toBe(Number(active.rows[0]?.version))
  })
})
