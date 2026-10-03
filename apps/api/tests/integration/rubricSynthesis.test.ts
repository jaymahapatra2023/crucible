/**
 * Rubric synthesis integration tests (E02-S04, E02-S05).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import {
  SAMPLE_BRIEF, fullSynthesisScript, gateTurn, generateTurn, judgeTurn, reviewTurn, rewriteTurn,
} from '../support/rubricFixtures.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { synthesiseRubric } from '../../src/modules/rubrics/services/rubricSynthesis.js'
import { createChallenge, uploadArtifact } from '../../src/modules/challenges/services/challengeService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let provider: FakeProvider
let challengeId: number

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'synth-test' }, fn)

async function seedChallenge(brief = SAMPLE_BRIEF): Promise<number> {
  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  await inScope(() => uploadArtifact({
    challengeId: challenge.challengeId, kind: 'BRIEF', filename: 'brief.md',
    mediaType: 'text/markdown', content: Buffer.from(brief), actor: ACTOR,
  }))
  return challenge.challengeId
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  resetGateway()
  installAuditPort()
  provider = installFakeProvider()
  challengeId = await seedChallenge()
})

afterEach(() => restoreProviders())

const synth = () => inScope(() => synthesiseRubric({
  challengeId, challengeName: 'Challenge Alpha', actor: ACTOR,
}))

describe('generation (E02-S04)', () => {
  it('produces a DRAFT rubric — generated criteria are never used unreviewed (F4)', async () => {
    provider.setScript(fullSynthesisScript([{ name: 'Ingests the telemetry feed' }]))
    const result = await synth()
    expect(result.rubric.status).toBe('DRAFT')
    expect(result.rubric.version).toBe(1)
  })

  it('persists each criterion with description, evidence spec, five anchors and a source ref', async () => {
    provider.setScript(fullSynthesisScript([{ name: 'Ingests the telemetry feed' }]))
    const { rubric } = await synth()
    const c = rubric.criteria[0]!
    expect(c.dimension).toBe('CHALLENGE_FIDELITY')
    expect(c.evidenceSpec.length).toBeGreaterThan(10)
    expect(Object.keys(c.anchors)).toHaveLength(5)
    expect(c.sourceRef).toBeTruthy()
  })

  it('assigns NO weight from the model — weights are a human decision (F4 invariant 2)', async () => {
    provider.setScript(fullSynthesisScript([
      { name: 'Ingests the feed' }, { name: 'Detects breaches' }, { name: 'Raises alerts' },
    ]))
    const { rubric } = await synth()
    // An even split is the placeholder; it is arbitrary by design and the committee must set it.
    const weights = rubric.criteria.map((c) => c.weight)
    expect(new Set(weights).size).toBeLessThanOrEqual(2)
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)

    // Nothing the model returned could have carried a weight.
    const generateRequest = provider.requests[0]!
    expect(generateRequest.user).not.toMatch(/"weight"/)
  })

  it('runs worker, reviewer AND judge — the reviewer is mandatory (P4.3)', async () => {
    provider.setScript(fullSynthesisScript([{ name: 'Ingests the feed' }]))
    await synth()
    const calls = await query<{ call_key: string }>(
      'SELECT call_key FROM llm_call_log ORDER BY log_id')
    const keys = calls.rows.map((r) => r.call_key)
    expect(keys).toContain('rubrics.criteria_generate')
    expect(keys).toContain('rubrics.criteria_review')
    expect(keys).toContain('rubrics.criteria_judge')
  })

  it('FAILS generation rather than degrading when the reviewer call fails', async () => {
    // Worker succeeds; reviewer never produces valid output. P4.3: the phase fails, it does not
    // silently proceed with an unreviewed set.
    provider.setScript([
      generateTurn([{ name: 'Ingests the feed' }]),
      { text: 'I cannot review that.' }, { text: 'Still cannot.' }, { text: 'No.' },
    ])
    await expect(synth()).rejects.toThrow()
  })

  it('refuses the whole set when the judge returns FAIL', async () => {
    provider.setScript([
      generateTurn([{ name: 'Is innovative' }]),
      reviewTurn({ not_checkable: [{ criterion_name: 'Is innovative', why: 'not locatable' }] }),
      judgeTurn('FAIL', 'Most criteria cannot be applied to a repository.'),
    ])
    await expect(synth()).rejects.toThrow(/unfit to review/)
  })

  it('re-running creates a NEW version and never mutates the existing one (acceptance 5)', async () => {
    provider.setScript(fullSynthesisScript([{ name: 'Ingests the feed' }]))
    const first = await synth()
    provider.setScript(fullSynthesisScript([
      { name: 'Ingests the feed' }, { name: 'Detects breaches' },
    ]))
    const second = await synth()

    expect(second.rubric.version).toBe(2)
    expect(second.rubric.rubricId).not.toBe(first.rubric.rubricId)

    const rows = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM rubric_criterion WHERE rubric_id = $1',
      [Number(first.rubric.rubricId)])
    expect(rows.rows[0]!.n).toBe(1) // v1 untouched
  })

  it('refuses to generate from a challenge with no extracted brief', async () => {
    const empty = await inScope(() => createChallenge({ name: 'No Brief', actor: ACTOR }))
    await expect(inScope(() => synthesiseRubric({
      challengeId: empty.challengeId, challengeName: 'No Brief', actor: ACTOR,
    }))).rejects.toThrow(/No brief text/)
  })

  it('refuses to generate from a brief too thin to support criteria (risk R3)', async () => {
    const thin = await inScope(() => createChallenge({ name: 'Thin', actor: ACTOR }))
    await inScope(() => uploadArtifact({
      challengeId: thin.challengeId, kind: 'BRIEF', filename: 'thin.md',
      mediaType: 'text/markdown', content: Buffer.from('# Do something clever'), actor: ACTOR,
    }))
    await expect(inScope(() => synthesiseRubric({
      challengeId: thin.challengeId, challengeName: 'Thin', actor: ACTOR,
    }))).rejects.toThrow(/too thin/)
  })

  it('fences the brief as untrusted data (P8.4)', async () => {
    provider.setScript(fullSynthesisScript([{ name: 'Ingests the feed' }]))
    await synth()
    expect(provider.requests[0]!.user).toContain('UNTRUSTED_DATA')
    expect(provider.requests[0]!.system).not.toContain('Telemetry triage')
  })
})

describe('quality gate (E02-S05)', () => {
  it('passes a checkable criterion through unchanged', async () => {
    provider.setScript(fullSynthesisScript([{ name: 'Ingests the telemetry feed' }]))
    const result = await synth()
    expect(result.gate).toMatchObject({ total: 1, checkable: 1, repaired: 0, needsRewrite: 0 })
    expect(result.rubric.criteria[0]?.needsRewrite).toBeUndefined()
  })

  it('regenerates a rejected criterion once, and accepts the repair (acceptance 2)', async () => {
    provider.setScript([
      generateTurn([{ name: 'Is innovative' }]),
      reviewTurn(), judgeTurn(),
      rewriteTurn('Implements the documented detection rule'),
      gateTurn('CHECKABLE'),
    ])
    const result = await synth()
    expect(result.gate).toMatchObject({ repaired: 1, needsRewrite: 0 })
    expect(result.rubric.criteria[0]?.name).toBe('Implements the documented detection rule')
  })

  it('surfaces a persistent failure as NEEDS_REWRITE rather than dropping it (acceptance 2)', async () => {
    provider.setScript([
      generateTurn([{ name: 'Is innovative' }]),
      reviewTurn(), judgeTurn(),
      rewriteTurn('Still vague'),
      gateTurn('UNCHECKABLE', { reasons: ['no wording of this can be located in a repository'] }),
    ])
    const result = await synth()

    // The criterion is still there — dropping it would quietly reshape the rubric.
    expect(result.rubric.criteria).toHaveLength(1)
    expect(result.rubric.criteria[0]?.needsRewrite).toBe(true)
    expect(result.gate.needsRewrite).toBe(1)
  })

  it('surfaces an UNCHECKABLE verdict immediately, without a pointless rewrite attempt', async () => {
    provider.setScript([
      generateTurn([{ name: 'Scales to a million users' }]),
      reviewTurn(), judgeTurn(),
      gateTurn('UNCHECKABLE', { reasons: ['requires load testing a reader cannot perform'] }),
    ])
    const result = await synth()
    expect(result.rubric.criteria[0]?.needsRewrite).toBe(true)
    expect(result.rubric.criteria[0]?.gateNotes?.join(' ')).toMatch(/load testing/)
  })

  it('records the gate decision with reasons, visible in review (acceptance 4)', async () => {
    provider.setScript([
      generateTurn([{ name: 'Is innovative' }]),
      reviewTurn(), judgeTurn(),
      gateTurn('UNCHECKABLE', { reasons: ['"innovative" is not observable in a repository'] }),
    ])
    const result = await synth()
    expect(result.rubric.criteria[0]?.gateNotes?.join(' ')).toMatch(/innovative/)

    const audit = await query<{ payload: { decisions: Array<{ verdict: string }> } }>(
      `SELECT payload FROM audit_event WHERE action = 'rubric.quality_gate_run'`)
    expect(audit.rows[0]?.payload.decisions[0]?.verdict).toBe('UNCHECKABLE')
  })

  it('does not lose the whole set when one gate call fails', async () => {
    provider.setScript([
      generateTurn([{ name: 'Ingests the feed' }, { name: 'Detects breaches' }]),
      reviewTurn(), judgeTurn(),
      gateTurn('CHECKABLE'),
      // Second criterion's gate call fails every attempt.
      { text: 'unparseable' }, { text: 'unparseable' }, { text: 'unparseable' },
    ])
    const result = await synth()
    expect(result.rubric.criteria).toHaveLength(2)
    expect(result.gate.needsRewrite).toBe(1)
    expect(result.rubric.criteria[1]?.gateNotes?.join(' ')).toMatch(/could not be run/)
  })

  it('can be switched off by feature flag, and says so in the notes', async () => {
    await query(`UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.rubrics.quality_gate'`)
    invalidateConfig()
    provider.setScript([generateTurn([{ name: 'Ingests the feed' }]), reviewTurn(), judgeTurn()])

    const result = await synth()
    expect(result.gate).toMatchObject({ total: 1, needsRewrite: 0 })
    expect(result.rubric.criteria[0]?.gateNotes?.join(' ')).toMatch(/disabled/)
  })

  it('refuses to generate at all when generation is disabled', async () => {
    await query(`UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.rubrics.criteria_generation'`)
    invalidateConfig()
    await expect(synth()).rejects.toThrow(/disabled/)
  })
})
