/**
 * A provider that lies (E13-S05, P4.1 clause 3).
 *
 * The containment suite does this for hostile submissions. This does it for the model.
 *
 * Everything here is schema-valid: correctly shaped, every required field present, a confident
 * rationale. What differs is that the citations point at source which does not exist. Before
 * this was enforced, every one of these would have been stored, rendered to a reviewer, and
 * reproduced verbatim in the team's appeal packet — and the system's entire claim to being
 * checkable would have rested on a reviewer opening the file by hand.
 *
 * The inverse matters just as much and is tested alongside: an honest citation to a file the
 * budget never reached must be ACCEPTED, because punishing that would mark a team down for a
 * limit we imposed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { loadRubric } from '../../src/modules/rubrics/services/rubricService.js'
import { scoreSubmission } from '../../src/modules/scoring/services/submissionScorer.js'
import { insertScoreRun, selectScoresFor } from '../../src/modules/scoring/db/scoringDb.js'
import { ACTOR, inScope, seedCohort, RESILIENCE_SOURCE } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'

let provider: FakeProvider
let runIndexId: number

/** The source the fixture repository actually contains, at the lines it contains it. */
const REAL_PATH = 'src/retry.ts'
const REAL_LINE_START = 1
const REAL_LINE_END = 12
const REAL_TEXT = 'export async function withRetry'

function scored(over: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      score: 3,
      insufficient_evidence: false,
      confidence: 90,
      anchor_matched: 'Retries with backoff on the main path.',
      rationale: 'The retry loop is present and applies backoff between attempts.',
      evidence: [{
        path: REAL_PATH,
        line_start: REAL_LINE_START,
        line_end: REAL_LINE_END,
        excerpt: REAL_TEXT,
      }],
      injection_noted: null,
      ...over,
    }),
  }
}

/** A well-formed score whose single citation is the given one. */
const citing = (evidence: Record<string, unknown>) => scored({ evidence: [evidence] })

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  const run = await insertScoreRun({
    runIndex: 1, cohortKey: `citations-${Date.now()}`, rubricVersions: {},
    model: 'fake', ledgerRunId: null, startedBy: ACTOR,
  })
  runIndexId = run.run_index_id
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

/**
 * Score one submission, answering the CRITERION call from `turns` and everything else benignly.
 *
 * Keyed on the prompt rather than on position: `scoreSubmission` also assesses principles,
 * standards and originality, so a positional script hands this test's turn to whichever call
 * happens to arrive first. That misalignment looks exactly like a product defect, which is why
 * the fake provider offers a responder at all.
 */
async function scoreWith(
  turns: Array<{ text: string }>,
  options: { truncated?: boolean } = {},
) {
  const cohort = await seedCohort({ count: 1, files: [RESILIENCE_SOURCE] })
  if (options.truncated) await markScanTruncated(cohort.submissionIds[0]!)

  let criterionCalls = 0
  provider.setResponder((req) => {
    const isCriterion = req.user.includes('"anchor_matched"')
    if (!isCriterion) return { text: JSON.stringify(INSUFFICIENT) }
    const turn = turns[Math.min(criterionCalls, turns.length - 1)]
    criterionCalls++
    return turn ?? { text: JSON.stringify(INSUFFICIENT) }
  })

  const rubric = await loadRubric(cohort.rubricId)
  const summary = await inScope(() => scoreSubmission({
    runIndexId, submissionId: cohort.submissionIds[0]!, rubric,
  }))
  const rows = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
  return { summary, rows, criterionCalls: () => criterionCalls }
}

/**
 * Record that the scan stopped short of the whole repository.
 *
 * Written into the persisted scan result because that is where the verifier reads it: whether
 * an absent file is innocent turns entirely on whether we finished looking.
 */
async function markScanTruncated(submissionId: number): Promise<void> {
  await query(
    `UPDATE scan
        SET budget_truncated = TRUE,
            raw_result = jsonb_set(
              jsonb_set(raw_result, '{budgetTruncated}', 'true'),
              '{filesTotal}', '40')
      WHERE submission_id = $1`,
    [submissionId])
}

/** A benign answer for every call this test is not about. Cites nothing, so nothing to check. */
const INSUFFICIENT = {
  score: null, maturity: null, compliance: null, level: null,
  insufficient_evidence: true, confidence: 10,
  anchor_matched: null, rationale: 'Not the call under test.',
  evidence: [], observations: [], injection_noted: null,
}

describe('a fabricated citation is refused', () => {
  it('rejects a citation to a file that does not exist', async () => {
    // Three identical attempts, so the ladder is exhausted rather than rescued by luck.
    const turn = citing({
      path: 'src/auth/session.ts', line_start: 42, line_end: 58,
      excerpt: 'const session = await verify(token)',
    })
    const { rows } = await scoreWith([turn, turn, turn])

    expect(rows[0]!.non_score).toBe('SCORING_FAILED')
    // Never a zero, and never the score it claimed.
    expect(rows[0]!.raw_score).toBeNull()
  })

  it('ACCEPTS a real quotation cited beyond the end of the file, and records the real line', () => {
    // Changed deliberately. The quotation is exact and the file is right; only the arithmetic is
    // wrong, and rejecting it cost the criterion entirely — which raised the entry's composite,
    // because the average is taken over the weight that was covered. Measured on the calibration
    // set this shape was 301 of 344 rejections.
    const turn = citing({
      path: REAL_PATH, line_start: 900, line_end: 950, excerpt: REAL_TEXT,
    })
    return scoreWith([turn]).then(({ rows }) => {
      expect(rows[0]!.non_score).toBeNull()
      expect(rows[0]!.raw_score).not.toBeNull()
    })
  })

  it('rejects a quotation that appears nowhere in the cited file', async () => {
    const turn = citing({
      path: REAL_PATH, line_start: REAL_LINE_START, line_end: REAL_LINE_END,
      excerpt: 'await auditLog.write({ actor, action })',
    })
    const { rows } = await scoreWith([turn, turn, turn])
    expect(rows[0]!.non_score).toBe('SCORING_FAILED')
  })

  it('rejects a response where only ONE of several citations is fabricated', async () => {
    // A response that invented one citation has not earned trust in the rest of itself, so it
    // fails whole rather than having its evidence quietly pruned.
    const turn = scored({
      evidence: [
        { path: REAL_PATH, line_start: REAL_LINE_START, line_end: REAL_LINE_END, excerpt: REAL_TEXT },
        { path: REAL_PATH, line_start: 1, line_end: 2, excerpt: 'const CACHE = new Map()' },
      ],
    })
    const { rows } = await scoreWith([turn, turn, turn])
    expect(rows[0]!.non_score).toBe('SCORING_FAILED')
  })

  it('records the rejection as SEMANTIC_INVALID, not as a schema failure', async () => {
    // The shape was correct and every field was present. Filing it as a schema failure would
    // hide the most useful thing the log could say.
    const turn = citing({ path: 'src/invented.ts', line_start: 1, line_end: 2, excerpt: 'x' })
    await scoreWith([turn, turn, turn])

    const statuses = await query<{ status: string; error: string }>(
      `SELECT status, error FROM llm_call_log WHERE call_key = 'scoring.criterion'
        ORDER BY log_id`)
    expect(statuses.rows.some((r) => r.status === 'SEMANTIC_INVALID')).toBe(true)
    expect(statuses.rows.some((r) => r.status === 'SCHEMA_INVALID')).toBe(false)
    expect(statuses.rows.find((r) => r.status === 'SEMANTIC_INVALID')!.error)
      .toMatch(/could not be found in the scanned source/i)
  })

  it('retries with an instruction naming the rule that was broken', async () => {
    const turn = citing({ path: 'src/invented.ts', line_start: 1, line_end: 2, excerpt: 'x' })
    await scoreWith([turn, turn, turn])

    // "Be accurate" is not actionable. The reinforcement must name the rule.
    const retried = provider.requests.filter((r) =>
      r.user.includes('cited a file, line range or quotation that does not exist'))
    expect(retried.length).toBeGreaterThan(0)
    expect(retried[0]!.user).toMatch(/insufficient evidence/i)
  })

  it('accepts a corrected citation on a later attempt', async () => {
    // The ladder is there to rescue a recoverable mistake, not only to reject.
    const bad = citing({ path: 'src/invented.ts', line_start: 1, line_end: 2, excerpt: 'x' })
    const { rows } = await scoreWith([bad, scored()])

    expect(rows[0]!.non_score).toBeNull()
    expect(rows[0]!.raw_score).toBe(3)
  })
})

describe('an honest citation is accepted', () => {
  it('accepts a citation that checks out, and records it as verified', async () => {
    const { rows } = await scoreWith([scored()])

    expect(rows[0]!.raw_score).toBe(3)
    expect(rows[0]!.evidence[0]).toMatchObject({ verdict: 'VERIFIED' })
  })

  it('accepts a citation to a file a TRUNCATED scan never read', async () => {
    // The file budget legitimately stops short, and the scan records that it did. Treating
    // this as fabrication would fail a criterion for a limit we imposed on ourselves.
    const { rows } = await scoreWith([
      citing({
        path: 'src/elsewhere/untouched.ts', line_start: 5, line_end: 9,
        excerpt: 'export const handler = () => {}',
      }),
    ], { truncated: true })

    expect(rows[0]!.non_score).toBeNull()
    expect(rows[0]!.raw_score).toBe(3)
    expect(rows[0]!.evidence[0]).toMatchObject({ verdict: 'UNVERIFIABLE' })
    expect(rows[0]!.evidence[0]!.verdictReason).toMatch(/may exist unread/i)
  })

  it('REFUSES the same citation when the scan read the whole repository', async () => {
    // The evasion this closes: without the truncation distinction, a model could dodge checking
    // entirely by citing only files outside the scan.
    const turn = citing({
      path: 'src/elsewhere/untouched.ts', line_start: 5, line_end: 9,
      excerpt: 'export const handler = () => {}',
    })
    const { rows } = await scoreWith([turn, turn, turn])
    expect(rows[0]!.non_score).toBe('SCORING_FAILED')
  })

  it('accepts a quotation trimmed with an ellipsis', async () => {
    const { rows } = await scoreWith([
      citing({
        path: REAL_PATH, line_start: REAL_LINE_START, line_end: REAL_LINE_END,
        excerpt: 'export async function ... Promise<T> {',
      }),
    ])
    expect(rows[0]!.raw_score).toBe(3)
    expect(rows[0]!.evidence[0]).toMatchObject({ verdict: 'VERIFIED' })
  })

  it('does not retry the criterion when its first citation holds', async () => {
    const { criterionCalls } = await scoreWith([scored()])
    expect(criterionCalls()).toBe(1)
  })

  it('leaves a score with no evidence alone — insufficient evidence cites nothing', async () => {
    const { rows } = await scoreWith([{
      text: JSON.stringify({
        score: null, insufficient_evidence: true, confidence: 20,
        anchor_matched: null, rationale: 'Nothing in the excerpts bears on this criterion.',
        evidence: [], injection_noted: null,
      }),
    }])

    expect(rows[0]!.non_score).toBe('INSUFFICIENT_EVIDENCE')
  })
})

describe('the verdict survives to the people who need it', () => {
  it('stores the verdict with the score rather than recomputing it later', async () => {
    // A reviewer months later must see the verdict reached when the score was taken, not one
    // reached against a scan that has since been superseded.
    const { rows } = await scoreWith([scored()])
    const stored = await query<{ evidence: Array<{ verdict: string; verdictReason: string }> }>(
      'SELECT evidence FROM criterion_score WHERE run_index_id = $1', [runIndexId])

    expect(stored.rows[0]!.evidence[0]!.verdict).toBe('VERIFIED')
    expect(stored.rows[0]!.evidence[0]!.verdictReason).toBeTruthy()
    expect(rows[0]!.evidence[0]!.verdict).toBe('VERIFIED')
  })
})
