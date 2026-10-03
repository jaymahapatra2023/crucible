/**
 * The appeal packet (E09-S02).
 *
 * The specification is a sentence: "an appeal is answered with a document rather than a database
 * query". These tests read the document the way the team would — checking that every figure it
 * cites is carried inside it, that a non-score is explained rather than coded, and that it says
 * what the system did and did not decide.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { decide, openShortlist } from '../../src/modules/review/services/shortlistService.js'
import { dismissFlag } from '../../src/modules/review/services/flagService.js'
import { appealPacket } from '../../src/modules/governance/services/appealPacket.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, insufficientTurn, originalityTurn, scoreTurn, seedCohort,
  type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let runId: number
let scoredTeam: number
let unevidencedTeam: number

const packetFor = (submissionId: number) =>
  appealPacket({ runIndexId: runId, submissionId, actor: 'organiser@test.local' })

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()

  await inScope(() => setConfig('scoring.cut_line', 1, ACTOR))
  await inScope(() => setConfig('scoring.cut_band_size', 0, ACTOR))
  invalidateConfig()

  cohort = await seedCohort({ count: 2 })
  scoredTeam = cohort.submissionIds[0]!
  unevidencedTeam = cohort.submissionIds[1]!

  provider.setScript([
    scoreTurn(3), originalityTurn(3),
    insufficientTurn(), originalityTurn(2),
  ])
  const outcome = await inScope(() => startRun({
    cohortKey: `appeal-${Date.now()}`, runIndex: 1,
    submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  runId = outcome.run.run_index_id
  await computeRanking(runId, ACTOR)
  await openShortlist(runId, ACTOR)
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('what the packet contains (acceptance 1)', () => {
  it('names the rubric version and its hash', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/version 1, hash [0-9a-f]{64}/)
  })

  it('carries every criterion with its rationale AND its evidence', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toContain('Handles failures without losing work')
    expect(packet).toMatch(/exponential backoff is present/)
    expect(packet).toContain('src/retry.ts')
    expect(packet).toContain('export async function withRetry')
  })

  it('quotes the ANCHORS the team was judged by, not just the score', async () => {
    const packet = await packetFor(scoredTeam)
    // A team cannot dispute a 3 without knowing what a 3 was defined to mean.
    expect(packet).toContain('Retries with backoff on the main path.')
    expect(packet).toContain('No evidence of retries or error handling.')
  })

  it('carries the build result, provenance, flags and the final rank', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toContain('## Build')
    expect(packet).toContain('## Commit history')
    expect(packet).toContain('## Caveats raised')
    expect(packet).toMatch(/Rank overall/)
  })

  it('carries the commit that was judged', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/Commit judged.*[0-9a-f]{40}/)
  })

  it('includes the recorded decision, its author and its reason', async () => {
    await decide({
      runIndexId: runId, submissionId: scoredTeam, decision: 'EXCLUDE',
      reason: 'The repository contains another team’s work; confirmed by hand.',
      actor: 'chair@test.local',
    })

    const packet = await packetFor(scoredTeam)
    expect(packet).toContain('EXCLUDE')
    expect(packet).toContain('chair@test.local')
    expect(packet).toMatch(/contains another team/)
  })

  it('includes the audit trail, and says it cannot be edited', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toContain('## Record of actions')
    expect(packet).toMatch(/cannot be edited or\ndeleted/)
    expect(packet).toContain('scoring.submission_scored')
  })
})

describe('what the packet SAYS (acceptance 2)', () => {
  it('explains a non-score instead of printing a code', async () => {
    const packet = await packetFor(unevidencedTeam)
    expect(packet).toMatch(/did not let this criterion be judged/)
    expect(packet).toMatch(/NOT a score of zero/)
    expect(packet).not.toContain('INSUFFICIENT_EVIDENCE')
  })

  it('states plainly that the system decided nothing', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/does not select or eliminate anyone/i)
  })

  it('WARNS that the cohort was too small to compare fidelity', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/too few to compare fidelity/)
  })

  it('says a dimension nobody scored was EXCLUDED, not counted as zero', async () => {
    const packet = await packetFor(unevidencedTeam)
    expect(packet).toMatch(/left out of the composite rather than scored zero|Excluded from the composite entirely/)
  })

  it('preserves the RAW fidelity score for independent checking', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/recorded before any comparison/)
  })

  it('shows a dismissed caveat WITH the reason it was set aside', async () => {
    await dismissFlag({
      runIndexId: runId, submissionId: scoredTeam, code: 'NOT_PROBED',
      actor: 'reviewer@test.local',
      reason: 'Probing was disabled for this event; agreed with the committee.',
    })

    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/Reviewed by reviewer@test.local/)
    expect(packet).toMatch(/Probing was disabled for this event/)
  })

  it('says when no decision was taken, rather than leaving the section blank', async () => {
    const packet = await packetFor(unevidencedTeam)
    expect(packet).toMatch(/No decision was recorded/)
  })

  it('is a readable document, not a data dump', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet.startsWith('# Evaluation record')).toBe(true)
    // No stray JSON, no bare identifiers standing in for prose.
    expect(packet).not.toMatch(/\{"|\}\]/)
  })
})

describe('generation is itself audited (acceptance 3)', () => {
  it('records who generated which packet', async () => {
    await packetFor(scoredTeam)

    const audit = await query<{ actor: string; subject_id: string; payload: { runIndexId: number } }>(
      `SELECT actor, subject_id, payload FROM audit_event
        WHERE action = 'governance.appeal_packet_generated'`)

    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.actor).toBe('organiser@test.local')
    expect(audit.rows[0]?.subject_id).toBe(String(scoredTeam))
    expect(audit.rows[0]?.payload.runIndexId).toBe(runId)
  })

  it('records each generation separately', async () => {
    await packetFor(scoredTeam)
    await packetFor(scoredTeam)

    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'governance.appeal_packet_generated'`)
    expect(audit.rows).toHaveLength(2)
  })
})

describe('refusals', () => {
  it('REFUSES a run that does not exist', async () => {
    await expect(appealPacket({ runIndexId: 999999, submissionId: scoredTeam, actor: ACTOR }))
      .rejects.toThrow(/not found/)
  })

  it('REFUSES a submission with no scores, rather than emitting empty sections', async () => {
    await query('DELETE FROM criterion_score WHERE submission_id = $1', [scoredTeam])
    await expect(packetFor(scoredTeam)).rejects.toThrow(/nothing to appeal against/)
  })

  it('uses the rubric the SCORES cite, not whichever is current', async () => {
    // A later rubric version must not rewrite the standard a team was judged against.
    await query(
      `INSERT INTO rubric (challenge_id, version, status, dimension_weights, generated_by)
       VALUES ($1, 2, 'DRAFT', '{}'::jsonb, 'test')`, [cohort.challengeId])

    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/version 1, hash/)
  })
})

describe('citation verdicts in the packet (E13-S04)', () => {
  it('says which quotations were found in the commit the team submitted', async () => {
    // This STRENGTHENS the packet: it turns "here is a quote" into "here is a quote we checked
    // against your commit", which is a materially stronger thing to defend a decision with.
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/were found in the commit you submitted/i)
  })

  it('marks a verified quotation as checked', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/Checked: this text is in the commit you submitted/i)
  })

  it('never implies doubt about the team when the limit was ours', async () => {
    const packet = await packetFor(scoredTeam)
    // If anything reads as unverifiable it must be framed as our reading, not their work.
    if (/could not check this quotation/i.test(packet)) {
      expect(packet).toMatch(/a limit of our reading, not a doubt about your work/i)
    }
    expect(packet).not.toMatch(/fabricat|invent(ed|ion)/i)
  })

  it('stays readable without system access', async () => {
    // The verdict lines must be sentences, not codes a reader has to look up.
    const packet = await packetFor(scoredTeam)
    expect(packet).not.toMatch(/\bVERIFIED\b|\bUNVERIFIABLE\b|\bCONTRADICTED\b/)
  })
})

describe('what the evaluators were told (E16-S01)', () => {
  it('says plainly when no discovery informed the run', async () => {
    // An omitted section reads as "there was nothing". A stated absence does not.
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/## What the evaluators were told about your code/)
    expect(packet).toMatch(/No discovery pass was run on this submission/)
  })

  it("states that the absence is not a deficiency in the team's work", async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).toMatch(/not a deficiency in your\s+work and nothing was scored down for it/)
  })

  it('keeps the packet self-contained — the section is text, not a reference', async () => {
    const packet = await packetFor(scoredTeam)
    expect(packet).not.toMatch(/see the discovery page|view in the system/i)
  })
})
