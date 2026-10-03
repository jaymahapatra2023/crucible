/**
 * Source-reference resolution (E02-S06 acceptance 3).
 *
 * The property under test is that traceability is *checkable*: a reviewer can follow a
 * criterion's citation to the passage it claims to come from, and is told plainly when the
 * citation cannot be resolved rather than being shown a confident-looking wrong passage.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { createChallenge, uploadArtifact } from '../../src/modules/challenges/services/challengeService.js'
import { briefSections, resolveSourceRef } from '../../src/modules/challenges/services/briefLookup.js'
import { SAMPLE_BRIEF } from '../support/rubricFixtures.js'
import { makePdf } from '../support/documentFixtures.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'brief' }, fn)

let challengeId: number

async function seed(content: Buffer, filename = 'brief.md', mediaType = 'text/markdown') {
  const challenge = await inScope(() => createChallenge({
    name: `Challenge ${Math.random().toString(36).slice(2, 8)}`, actor: ACTOR,
  }))
  await inScope(() => uploadArtifact({
    challengeId: challenge.challengeId, kind: 'BRIEF', filename, mediaType, content, actor: ACTOR,
  }))
  return challenge.challengeId
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  challengeId = await seed(Buffer.from(SAMPLE_BRIEF))
})

describe('briefSections', () => {
  it('returns each extracted section with its text', async () => {
    const sections = await briefSections(challengeId)
    expect(sections.length).toBeGreaterThanOrEqual(3)
    const ingestion = sections.find((s) => s.label.includes('2.1'))
    expect(ingestion?.text).toContain('parse each record')
  })

  it('names the file each section came from', async () => {
    expect((await briefSections(challengeId))[0]?.filename).toBe('brief.md')
  })

  it('is empty when nothing has been extracted', async () => {
    const empty = await inScope(() => createChallenge({ name: 'Empty', actor: ACTOR }))
    expect(await briefSections(empty.challengeId)).toEqual([])
  })
})

describe('resolveSourceRef', () => {
  it('resolves a section-numbered reference to the right passage', async () => {
    const passage = await resolveSourceRef(challengeId, 'brief §2.1, para 3')
    expect(passage.matched).toBe(true)
    expect(passage.section?.label).toContain('2.1')
    expect(passage.section?.text).toContain('telemetry feed')
  })

  it('resolves a reference written with a heading instead of a number', async () => {
    const passage = await resolveSourceRef(challengeId, 'the Detection section')
    expect(passage.matched).toBe(true)
    expect(passage.section?.label.toLowerCase()).toContain('detection')
  })

  it('distinguishes between sections rather than always returning the first', async () => {
    const ingestion = await resolveSourceRef(challengeId, 'brief §2.1')
    const alerting = await resolveSourceRef(challengeId, 'brief §4.1')
    expect(ingestion.section?.label).not.toBe(alerting.section?.label)
    expect(alerting.section?.text).toContain('cool-down')
  })

  it('says plainly when a reference cannot be resolved (never a confident wrong passage)', async () => {
    const passage = await resolveSourceRef(challengeId, 'appendix Q, subsection zeta')
    expect(passage.matched).toBe(false)
    expect(passage.reason).toMatch(/by hand before approving/)
    expect(passage.section).toBeUndefined()
  })

  it('explains when there is no extracted brief at all', async () => {
    const empty = await inScope(() => createChallenge({ name: 'Nothing', actor: ACTOR }))
    const passage = await resolveSourceRef(empty.challengeId, 'brief §1')
    expect(passage.matched).toBe(false)
    expect(passage.reason).toMatch(/No brief text has been extracted/)
  })

  it('works for a PDF brief, where sections are pages', async () => {
    const pdfChallenge = await seed(
      makePdf(['Teams must ingest the telemetry feed and raise alerts.'], 2),
      'brief.pdf', 'application/pdf')
    const passage = await resolveSourceRef(pdfChallenge, 'page 2')
    expect(passage.matched).toBe(true)
    expect(passage.section?.label).toBe('page 2')
  })
})
