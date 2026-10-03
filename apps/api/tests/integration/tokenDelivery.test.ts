/**
 * Getting each team the code it needs to submit (E29-S02, E34).
 *
 * The property that shapes every test here: a token's plaintext exists for one moment, inside
 * the response that issued it. So delivery happens in that act or not at all, and nothing
 * persisted afterwards may contain the credential — which is exactly what a naive delivery log
 * would store.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { teams } from '../../src/lib/ports/teamPort.js'
import {
  mail, registerMailProvider, resetMailProvider, type MailMessage,
} from '../../src/lib/ports/mailPort.js'
import { RECORDING_PROVIDER } from '../../src/modules/submissions/services/mailProviders.js'
import {
  deliveryState, prepareDelivery,
} from '../../src/modules/submissions/services/tokenDelivery.js'
import { issueForTeamsWithout, deliverIssued } from '../../src/modules/submissions/services/bulkTokens.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'delivery' }, fn)

const makeTeam = (name: string, contactEmail = `${name.toLowerCase()}@example.test`) =>
  inScope(() => teams().create({ displayName: name, contactEmail, actor: ACTOR }))

/** A provider that transmits, for the tests about what happens when one is configured. */
function sendingProvider() {
  const sent: MailMessage[] = []
  registerMailProvider({
    name: 'test-sender',
    sends: true,
    async send(message) {
      sent.push(message)
      return { delivered: true, detail: 'Sent.' }
    },
  })
  return sent
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  installTeamPort()
  registerMailProvider(RECORDING_PROVIDER)
})

describe('the placeholder provider', () => {
  it('composes a real message and records PREPARED, not SENT', async () => {
    await makeTeam('Alpha')
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    expect(report.sends).toBe(false)
    expect(report.outcomes[0]?.status).toBe('PREPARED')
    // Claiming SENT would be claiming something nobody did.
    expect(report.outcomes.map((o) => o.status)).not.toContain('SENT')

    const rows = await query<{ status: string }>('SELECT status FROM token_delivery')
    expect(rows.rows[0]?.status).toBe('PREPARED')
  })

  it('hands back a message carrying the code, addressed to the team', async () => {
    await makeTeam('Alpha', 'alpha@example.test')
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    const message = report.messages[0]!
    expect(message.to).toBe('alpha@example.test')
    expect(message.body).toContain(plan.rows[0]!.token!)
    expect(message.subject).toContain('Alpha')
  })
})

describe('what is never written down', () => {
  it('stores no token and no address in the delivery record (P8.3)', async () => {
    await makeTeam('Alpha', 'alpha@example.test')
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    await inScope(() => deliverIssued(plan.rows, ACTOR))

    const rows = await query('SELECT * FROM token_delivery')
    const dumped = JSON.stringify(rows.rows)
    expect(dumped).not.toContain(plan.rows[0]!.token!)
    expect(dumped).not.toContain('alpha@example.test')
  })

  it('puts no token and no address in the audit trail either', async () => {
    await makeTeam('Alpha', 'alpha@example.test')
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    await inScope(() => deliverIssued(plan.rows, ACTOR))

    const audit = await query(
      `SELECT payload FROM audit_event WHERE action = 'submissions.tokens_delivered'`)
    const dumped = JSON.stringify(audit.rows)
    expect(dumped).not.toContain(plan.rows[0]!.token!)
    expect(dumped).not.toContain('alpha@example.test')
    expect(audit.rows).toHaveLength(1)
  })
})

describe('a team that cannot be reached', () => {
  it('is recorded as FAILED and named, rather than skipped quietly', async () => {
    await makeTeam('Reachable', 'ok@example.test')
    await makeTeam('Unreachable', '')

    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    const failed = report.outcomes.find((o) => o.teamName === 'Unreachable')
    expect(failed?.status).toBe('FAILED')
    expect(failed?.detail).toMatch(/No contact address/)
    // And it is the team, not the count, that the record names.
    const state = await deliveryState()
    expect(state.find((t) => t.teamName === 'Unreachable')?.status).toBe('FAILED')
  })

  it('shows NONE for a team nothing was attempted for, not a failure', async () => {
    await makeTeam('Untouched')
    // Nothing issued, nothing delivered.
    const state = await deliveryState()
    expect(state[0]?.status).toBe('NONE')
    expect(state[0]?.attempts).toBe(0)
  })

  it('records a provider failure against the team, with the error redacted', async () => {
    await makeTeam('Alpha')
    registerMailProvider({
      name: 'broken', sends: true,
      async send() { throw new Error('upstream refused the request') },
    })

    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    expect(report.outcomes[0]?.status).toBe('FAILED')
    expect(report.outcomes[0]?.detail).toMatch(/upstream refused/)
  })
})

describe('a provider that actually sends', () => {
  it('records SENT with a time, and hands back no messages to send by hand', async () => {
    const sent = sendingProvider()
    await makeTeam('Alpha', 'alpha@example.test')

    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))
    const report = await inScope(() => deliverIssued(plan.rows, ACTOR))

    expect(report.sends).toBe(true)
    expect(report.outcomes[0]?.status).toBe('SENT')
    expect(report.messages).toHaveLength(0)
    expect(sent[0]?.to).toBe('alpha@example.test')

    const rows = await query<{ sent_at: Date | null }>('SELECT sent_at FROM token_delivery')
    expect(rows.rows[0]?.sent_at).not.toBeNull()
  })

  it('counts a second attempt rather than adding a second row', async () => {
    sendingProvider()
    await makeTeam('Alpha')
    const plan = await inScope(() => issueForTeamsWithout({ confirm: true, actor: ACTOR }))

    await inScope(() => deliverIssued(plan.rows, ACTOR))
    await inScope(() => deliverIssued(plan.rows, ACTOR))

    const rows = await query<{ attempts: number }>('SELECT attempts FROM token_delivery')
    expect(rows.rows).toHaveLength(1)
    expect(Number(rows.rows[0]?.attempts)).toBe(2)
  })
})

describe('the port itself', () => {
  it('THROWS when unregistered, rather than reporting a delivery nobody made', async () => {
    resetMailProvider()
    await expect(mail().send({ to: 'a@b.test', subject: 's', body: 'b', idempotencyKey: 'test/1' }))
      .rejects.toThrow(/No mail provider is registered/)
    registerMailProvider(RECORDING_PROVIDER)
  })

  it('refuses to deliver when nothing was issued, saying why it cannot be done later', async () => {
    await expect(inScope(() => prepareDelivery({ deliverables: [], actor: ACTOR })))
      .resolves.toBeDefined()
    await expect(inScope(() => deliverIssued([], ACTOR)))
      .rejects.toThrow(/plaintext is not stored/)
  })
})
