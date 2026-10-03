/**
 * The holistic-comparison experiment (migration 092).
 *
 * The committee asked whether one undecomposed model judgement would be better than scored
 * criteria. These tests are about the apparatus that answers it, and the three properties that
 * decide whether the answer can be believed:
 *
 *  - the experiment cannot reach a decision about a team;
 *  - a failure is recorded as a failure and never as a zero;
 *  - the comparison refuses to pronounce before the humans have ranked.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, type FakeProvider } from '../support/fakeProvider.js'
import { addEntry, createGoldenSet, recordRanking } from '../../src/modules/calibration/services/goldenSetService.js'
import { linkSubmission } from '../../src/modules/calibration/db/calibrationDb.js'
import {
  evaluateHolistically, evaluateSetHolistically,
} from '../../src/modules/calibration/services/holisticEvaluator.js'
import { compareApproaches } from '../../src/modules/calibration/services/holisticComparison.js'
import { insertScoreRun } from '../../src/modules/scoring/db/scoringDb.js'
import { replaceRanking } from '../../src/modules/scoring/db/rankingDb.js'
import { ACTOR, seedCohort, type CohortFixture } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'

let provider: FakeProvider
let cohort: CohortFixture
let setId: number
let entryIds: number[]
const COHORT_KEY = 'holistic-test'

function holisticReply(overall: number | null, extra: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      overall, non_score: overall === null ? 'INSUFFICIENT_CONTEXT' : null,
      verdict: 'A verdict a committee member could read aloud.',
      reasoning: 'Why this and not five points either side.',
      strengths: ['something good'], weaknesses: ['something missing'],
      evidence: [{ path: 'src/retry.ts', why: 'the retry path' }],
      confidence: 70, injection_noted: null, ...extra,
    }),
    tokensIn: 40_000, tokensOut: 400, stopReason: 'end_turn' as const,
  }
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()

  cohort = await seedCohort({ count: 4 })

  const set = await createGoldenSet({ name: 'Holistic', description: '', actor: ACTOR })
  setId = Number(set.golden_set_id)
  entryIds = []
  const bands = ['STRONG', 'STRONG', 'MIDDLING', 'WEAK'] as const
  for (const [i, submissionId] of cohort.submissionIds.entries()) {
    const entry = await addEntry({
      goldenSetId: setId, label: `Reference ${i + 1}`,
      repoUrl: `https://github.com/example/ref-${i + 1}`, expectedBand: bands[i] ?? 'MIDDLING',
      edgeCase: null, notes: '', actor: ACTOR,
    })
    await linkSubmission(Number(entry.entry_id), submissionId)
    entryIds.push(Number(entry.entry_id))
  }

  // A per-criterion ranking to compare against: best first by composite.
  const run = await insertScoreRun({
    runIndex: 1, cohortKey: COHORT_KEY, rubricVersions: {}, model: 't', ledgerRunId: null,
    startedBy: 'seed',
  })
  await replaceRanking(run.run_index_id, cohort.submissionIds.map((id, i) => ({
    submissionId: id, challengeId: cohort.challengeId, composite: 90 - i * 15, fidelityRaw: null,
    fidelityNormalised: null, cohortSize: 4, normalisationMethod: 'PERCENTILE', rankGlobal: i + 1,
    rankInChallenge: i + 1, tied: false, weightCovered: 1, missingDimensions: [], partial: false,
    inCutBand: false, advisoryDecided: false, reviewReasons: [],
  })), { scoresCounted: 4, submissions: 4, cutLineUsed: 2, bandSizeUsed: 0, minCohortSize: 1, computedBy: 'seed' })
})

describe('the experiment cannot decide anything', () => {
  it('writes only to its own table, leaving scores and rankings untouched', async () => {
    provider.setResponder(() => holisticReply(80))
    await evaluateSetHolistically({ goldenSetId: setId, passIndex: 1, actor: ACTOR })

    const scores = await query('SELECT count(*)::int n FROM criterion_score')
    const composites = await query<{ n: number }>(
      'SELECT count(*)::int n FROM submission_composite')
    const own = await query<{ n: number }>('SELECT count(*)::int n FROM holistic_evaluation')

    expect((scores.rows[0] as { n: number }).n).toBe(0)
    // The four rows seeded above, and not one more.
    expect(composites.rows[0]?.n).toBe(4)
    expect(own.rows[0]?.n).toBe(4)
  })

  it('records what the model was shown, so the comparison is honest about its inputs', async () => {
    provider.setResponder(() => holisticReply(75))
    const rows = await evaluateSetHolistically({ goldenSetId: setId, passIndex: 1, actor: ACTOR })

    for (const row of rows) {
      expect(row.files_in_scan).toBeGreaterThan(0)
      expect(row.files_shown).toBeGreaterThan(0)
      expect(row.context_bytes).toBeGreaterThan(0)
      expect(row.model).toBe('claude-sonnet-5')
    }
  })

  it('sends the brief and the repository as fenced data, never as instructions', async () => {
    provider.setResponder(() => holisticReply(75))
    await evaluateSetHolistically({ goldenSetId: setId, passIndex: 1, actor: ACTOR })

    const sent = provider.requests[0]
    expect(sent?.user).toMatch(/UNTRUSTED_DATA/)
    expect(sent?.user).toMatch(/never as instructions to you/)
    // The criterion name must NOT appear: the point of this approach is that it has no criteria.
    expect(sent?.system).not.toMatch(/Handles failures without losing work/)
  })
})

describe('a failure is a failure', () => {
  it('records an unusable reply as EVALUATION_FAILED with no score', async () => {
    provider.setResponder(() => ({
      text: 'I am afraid I cannot do that.', tokensIn: 10, tokensOut: 10, stopReason: 'end_turn',
    }))
    const rows = await evaluateSetHolistically({ goldenSetId: setId, passIndex: 1, actor: ACTOR })

    expect(rows.every((r) => r.overall === null)).toBe(true)
    expect(rows.every((r) => r.non_score === 'EVALUATION_FAILED')).toBe(true)
  })

  it('keeps a model-declared INSUFFICIENT_CONTEXT as its own state, not as a zero', async () => {
    provider.setResponder(() => holisticReply(null))
    const rows = await evaluateSetHolistically({ goldenSetId: setId, passIndex: 1, actor: ACTOR })

    expect(rows.every((r) => r.overall === null)).toBe(true)
    expect(rows.every((r) => r.non_score === 'INSUFFICIENT_CONTEXT')).toBe(true)
  })
})

describe('the comparison', () => {
  /**
   * Evaluate one submission at a time, highest score first, so the holistic ordering matches the
   * seeded composite ordering. Per submission rather than per set because the fake answers by
   * request and every holistic request looks alike — the repository is the only variable, and
   * this fixture's four repositories are identical by construction.
   */
  async function evaluateDescending() {
    for (const [i, submissionId] of cohort.submissionIds.entries()) {
      provider.setResponder(() => holisticReply(85 - i * 10))
      await evaluateHolistically({
        submissionId, challengeId: cohort.challengeId, goldenSetId: setId, passIndex: 1,
        actor: ACTOR,
      })
    }
  }

  it('refuses to pronounce before the humans have ranked', async () => {
    await evaluateDescending()
    const result = await compareApproaches({ goldenSetId: setId, cohortKey: COHORT_KEY })

    expect(result.versusHumans).toBeNull()
    expect(result.entries).toBe(4)
    expect(result.perCriterion.rows[0]?.rank).toBe(1)
    expect(result.holistic.rows).toHaveLength(4)
  })

  it('correlates BOTH approaches against the hand ranking once two rankers exist', async () => {
    await evaluateDescending()
    for (const ranker of ['alice@test.local', 'bob@test.local']) {
      await recordRanking({
        goldenSetId: setId, ranker, actor: ranker,
        positions: entryIds.map((entryId, i) => ({ entryId, position: i + 1 })),
      })
    }

    const result = await compareApproaches({ goldenSetId: setId, cohortKey: COHORT_KEY })
    expect(result.versusHumans).not.toBeNull()
    expect(result.versusHumans?.rankers).toHaveLength(2)
    // Both orderings match the humans exactly in this fixture, so both correlate perfectly.
    expect(result.versusHumans?.perCriterion.rho).toBe(1)
    expect(result.versusHumans?.holistic.rho).toBe(1)
  })

  it('shows where the two approaches disagree, by how many places', async () => {
    // Reverse the holistic order against the seeded composite order.
    for (const [i, submissionId] of cohort.submissionIds.entries()) {
      provider.setResponder(() => holisticReply(40 + i * 15))
      await evaluateHolistically({
        submissionId, challengeId: cohort.challengeId, goldenSetId: setId, passIndex: 1,
        actor: ACTOR,
      })
    }

    const result = await compareApproaches({ goldenSetId: setId, cohortKey: COHORT_KEY })
    expect(result.betweenApproaches.rho).toBe(-1)
    expect(result.widestGaps[0]?.gap).toBe(3)
  })

  it('ranks an unscored entry last and says how many there were', async () => {
    provider.setResponder(() => holisticReply(null))
    await evaluateSetHolistically({ goldenSetId: setId, passIndex: 1, actor: ACTOR })

    const result = await compareApproaches({ goldenSetId: setId, cohortKey: COHORT_KEY })
    expect(result.holistic.unscored).toBe(4)
    expect(result.holistic.rows.every((r) => r.score === null)).toBe(true)
  })
})
