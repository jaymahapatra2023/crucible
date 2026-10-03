/**
 * A golden entry is not an entrant (migration 091).
 *
 * Golden-set repositories are entered through the ordinary submission path on purpose — that is
 * what makes calibration measure the real scanner, prober and scorer. The consequence is that
 * they are VALID submissions against the same challenge the teams enter, and before this they
 * would have been swept into a real cohort run: ranked with the entrants, counted in the cohort
 * size that drives percentile normalisation, and able to displace a team at the cut line.
 *
 * So the batch excludes them, and the run that does score them names them.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { eligibleSubjects, namedSubjects } from '../../src/modules/batch/db/batchDb.js'
import { addEntry, createGoldenSet } from '../../src/modules/calibration/services/goldenSetService.js'
import { linkSubmission } from '../../src/modules/calibration/db/calibrationDb.js'
import { ACTOR, seedCohort, type CohortFixture } from '../support/scoringFixtures.js'

let cohort: CohortFixture
let goldenSubmissionId: number
let teamSubmissionIds: number[]

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()

  // Three submissions against one challenge. The third stands in for a golden repository:
  // entered the same way, indistinguishable until the golden set claims it.
  cohort = await seedCohort({ count: 3 })
  goldenSubmissionId = cohort.submissionIds[2]!
  teamSubmissionIds = cohort.submissionIds.slice(0, 2)

  const set = await createGoldenSet({ name: 'Isolation', description: '', actor: ACTOR })
  const entry = await addEntry({
    goldenSetId: Number(set.golden_set_id), label: 'Reference — strong',
    repoUrl: 'https://github.com/example/reference-strong', expectedBand: 'STRONG',
    edgeCase: null, notes: '', actor: ACTOR,
  })
  await linkSubmission(Number(entry.entry_id), goldenSubmissionId)
})

describe('an ordinary cohort run', () => {
  it('covers the teams and NOT the golden entry', async () => {
    const subjects = await eligibleSubjects([cohort.challengeId])
    expect(subjects.map((s) => s.submission_id).sort()).toEqual([...teamSubmissionIds].sort())
    expect(subjects.map((s) => s.submission_id)).not.toContain(goldenSubmissionId)
  })

  it('counts a cohort without the golden entry, because cohort size drives normalisation', async () => {
    // The number that matters: a 3-strong cohort that is really 2 teams would normalise every
    // team against a repository nobody entered.
    expect(await eligibleSubjects([cohort.challengeId])).toHaveLength(2)
  })

  it('excludes it from an all-challenges run too, not only a scoped one', async () => {
    const subjects = await eligibleSubjects([])
    expect(subjects.map((s) => s.submission_id)).not.toContain(goldenSubmissionId)
  })
})

describe('the calibration run', () => {
  it('reaches the golden entry by naming it', async () => {
    const subjects = await namedSubjects([goldenSubmissionId])
    expect(subjects.map((s) => s.submission_id)).toEqual([goldenSubmissionId])
  })

  it('drops a named submission that never validated rather than carrying it into the run', async () => {
    expect(await namedSubjects([999_999])).toEqual([])
  })

  it('keeps the same deterministic order as an ordinary run', async () => {
    const named = await namedSubjects(cohort.submissionIds)
    expect(named.map((s) => s.submission_id)).toEqual([...cohort.submissionIds].sort((a, b) => a - b))
  })
})
