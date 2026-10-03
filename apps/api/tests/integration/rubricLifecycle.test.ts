/**
 * Rubric review, weighting, approval, freeze, versioning and publication
 * (E02-S06, E02-S07, E02-S08).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { hashRubric, type Dimension } from '@crucible/rubric'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import {
  approvalReadiness, approveRubric, createVersion, freezeRubric, frozenRubric,
  listRubrics, loadRubric, setDimensionWeights,
} from '../../src/modules/rubrics/services/rubricService.js'
import {
  addCriterion, editCriterion, removeCriterion, reorderCriteria, setCriterionWeights,
} from '../../src/modules/rubrics/services/criterionEditor.js'
import {
  publishRubric, publishedRubricBySlug, toHtml, toMarkdown,
} from '../../src/modules/rubrics/services/rubricExport.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'lifecycle' }, fn)

const anchors = { 0: 'none', 1: 'named only', 2: 'present but unused', 3: 'works', 4: 'works and is tested' }

function criterionInput(name: string, dimension: Dimension, weight: number, sortOrder = 0) {
  return {
    dimension, name,
    description: `Whether the submission ${name.toLowerCase()}.`,
    weight,
    evidenceSpec: 'A reader can point to the implementing code and its call sites.',
    anchors,
    sourceRef: dimension === 'CHALLENGE_FIDELITY' ? 'brief §2.1' : null,
    sortOrder,
  }
}

let challengeId: number

/** A rubric that validates: one dimension, weights summing to 1. */
async function draftRubric(): Promise<number> {
  const rubric = await inScope(() => createVersion({
    challengeId,
    criteria: [
      criterionInput('Ingests the feed', 'CHALLENGE_FIDELITY', 0.6, 0),
      criterionInput('Detects breaches', 'CHALLENGE_FIDELITY', 0.4, 1),
    ],
    actor: ACTOR,
  }))
  return Number(rubric.rubricId)
}

/** Weights across dimensions must also sum to 1; put everything on fidelity for these tests. */
async function makeApprovable(rubricId: number): Promise<void> {
  await inScope(() => setDimensionWeights(rubricId, {
    CHALLENGE_FIDELITY: 1, ENGINEERING_QUALITY: 0, PRINCIPLES_STANDARDS: 0,
    RUNS: 0, ORIGINALITY: 0,
  }, ACTOR))
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  challengeId = challenge.challengeId
})

describe('editing (E02-S06 acceptance 1)', () => {
  it('adds a criterion by hand', async () => {
    const id = await draftRubric()
    await inScope(() => addCriterion({
      rubricId: id, dimension: 'ENGINEERING_QUALITY', name: 'Has tests',
      description: 'Whether the submission carries tests.', weight: 1,
      evidenceSpec: 'A reader can point to test files and a runner configuration.',
      anchors, actor: ACTOR,
    }))
    const rubric = await loadRubric(id)
    expect(rubric.criteria.map((c) => c.name)).toContain('Has tests')
  })

  it('edits a criterion', async () => {
    const id = await draftRubric()
    const rubric = await loadRubric(id)
    const target = Number(rubric.criteria[0]!.criterionId)

    await inScope(() => editCriterion({
      rubricId: id, criterionId: target,
      patch: { name: 'Ingests the telemetry feed correctly' }, actor: ACTOR,
    }))
    expect((await loadRubric(id)).criteria.find((c) => c.criterionId === String(target))?.name)
      .toBe('Ingests the telemetry feed correctly')
  })

  it('removes a criterion', async () => {
    const id = await draftRubric()
    const rubric = await loadRubric(id)
    await inScope(() => removeCriterion(id, Number(rubric.criteria[0]!.criterionId), ACTOR))
    expect((await loadRubric(id)).criteria).toHaveLength(1)
  })

  it('reorders criteria without changing the content hash', async () => {
    const id = await draftRubric()
    const before = await loadRubric(id)
    const hashBefore = hashRubric(before.criteria, before.dimensionWeights)

    const reversed = [...before.criteria].reverse().map((c) => Number(c.criterionId))
    await inScope(() => reorderCriteria(id, reversed, ACTOR))

    const after = await loadRubric(id)
    expect(after.criteria[0]?.name).toBe(before.criteria[1]?.name)
    // Display order does not change how anything scores, so it must not change the hash.
    expect(hashRubric(after.criteria, after.dimensionWeights)).toBe(hashBefore)
  })

  it('refuses a reorder that does not list every criterion', async () => {
    const id = await draftRubric()
    const rubric = await loadRubric(id)
    await expect(inScope(() => reorderCriteria(id, [Number(rubric.criteria[0]!.criterionId)], ACTOR)))
      .rejects.toThrow(/every criterion/)
  })

  it('records every edit in the audit trail', async () => {
    const id = await draftRubric()
    const rubric = await loadRubric(id)
    await inScope(() => editCriterion({
      rubricId: id, criterionId: Number(rubric.criteria[0]!.criterionId),
      patch: { weight: 0.5 }, actor: ACTOR,
    }))
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'rubric.edited'`)
    expect(rows.rows[0]!.n).toBeGreaterThan(0)
  })
})

describe('weighting (E02-S06 acceptance 2)', () => {
  it('sets weights for a whole dimension at once', async () => {
    const id = await draftRubric()
    const rubric = await loadRubric(id)
    const [a, b] = rubric.criteria

    const updated = await inScope(() => setCriterionWeights({
      rubricId: id, dimension: 'CHALLENGE_FIDELITY',
      weights: { [a!.criterionId]: 0.75, [b!.criterionId]: 0.25 },
      actor: ACTOR,
    }))
    expect(updated.map((c) => c.weight).sort()).toEqual([0.25, 0.75])
  })

  it('refuses a partial weight update — it would leave the dimension invalid mid-edit', async () => {
    const id = await draftRubric()
    const rubric = await loadRubric(id)
    await expect(inScope(() => setCriterionWeights({
      rubricId: id, dimension: 'CHALLENGE_FIDELITY',
      weights: { [rubric.criteria[0]!.criterionId]: 1 },
      actor: ACTOR,
    }))).rejects.toThrow(/every criterion in CHALLENGE_FIDELITY/)
  })

  it('BLOCKS approval until each dimension sums to 1.0', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    const rubric = await loadRubric(id)

    await inScope(() => setCriterionWeights({
      rubricId: id, dimension: 'CHALLENGE_FIDELITY',
      weights: {
        [rubric.criteria[0]!.criterionId]: 0.5,
        [rubric.criteria[1]!.criterionId]: 0.2,
      },
      actor: ACTOR,
    }))

    const readiness = await approvalReadiness(id)
    expect(readiness.canApprove).toBe(false)
    expect(readiness.report.errors.map((e) => e.code)).toContain('DIMENSION_WEIGHTS_NOT_ONE')
    await expect(inScope(() => approveRubric(id, ACTOR))).rejects.toThrow(/cannot be approved/)
  })

  it('reports the running total so the UI can show how far off it is', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    const rubric = await loadRubric(id)
    await inScope(() => setCriterionWeights({
      rubricId: id, dimension: 'CHALLENGE_FIDELITY',
      weights: { [rubric.criteria[0]!.criterionId]: 0.5, [rubric.criteria[1]!.criterionId]: 0.2 },
      actor: ACTOR,
    }))
    const readiness = await approvalReadiness(id)
    expect(readiness.report.errors[0]?.message).toMatch(/0\.7000/)
  })
})

describe('warnings must be acknowledged (E02-S06 acceptance 4)', () => {
  it('blocks approval while a quality-gate warning is unacknowledged', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await query(
      `UPDATE rubric_criterion SET needs_rewrite = TRUE, gate_notes = '["not locatable"]'::jsonb
        WHERE rubric_id = $1 AND sort_order = 0`, [id])

    const readiness = await approvalReadiness(id)
    expect(readiness.canApprove).toBe(false)
    expect(readiness.unacknowledgedWarnings).toContain('NEEDS_REWRITE')
    await expect(inScope(() => approveRubric(id, ACTOR))).rejects.toThrow(/must be acknowledged/)
  })

  it('permits approval once the warning is explicitly acknowledged', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await query(
      `UPDATE rubric_criterion SET needs_rewrite = TRUE, gate_notes = '["not locatable"]'::jsonb
        WHERE rubric_id = $1 AND sort_order = 0`, [id])

    const approved = await inScope(() => approveRubric(id, ACTOR, ['NEEDS_REWRITE']))
    expect(approved.status).toBe('APPROVED')

    const audit = await query<{ payload: { acknowledgedWarnings: string[] } }>(
      `SELECT payload FROM audit_event WHERE action = 'rubric.approved'`)
    expect(audit.rows[0]?.payload.acknowledgedWarnings).toContain('NEEDS_REWRITE')
  })
})

describe('approve, freeze, version (E02-S07)', () => {
  it('records actor and timestamp on approval, then transitions to FROZEN', async () => {
    const id = await draftRubric()
    await makeApprovable(id)

    const approved = await inScope(() => approveRubric(id, ACTOR))
    expect(approved.status).toBe('APPROVED')
    expect(approved.approvedBy).toBe(ACTOR)
    expect(approved.approvedAt).toBeTruthy()

    const frozen = await inScope(() => freezeRubric(id, ACTOR))
    expect(frozen.status).toBe('FROZEN')
    expect(frozen.frozenAt).toBeTruthy()
  })

  it('computes and stores the content hash at freeze (acceptance 4)', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await inScope(() => approveRubric(id, ACTOR))
    const frozen = await inScope(() => freezeRubric(id, ACTOR))

    expect(frozen.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(frozen.contentHash).toBe(hashRubric(frozen.criteria, frozen.dimensionWeights))
  })

  it('refuses to freeze a rubric that was never approved', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await expect(inScope(() => freezeRubric(id, ACTOR))).rejects.toThrow(/Only an APPROVED rubric/)
  })

  it('refuses every edit after freeze, at the DATABASE level (acceptance 2)', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await inScope(() => approveRubric(id, ACTOR))
    const frozen = await inScope(() => freezeRubric(id, ACTOR))
    const criterionId = Number(frozen.criteria[0]!.criterionId)

    // Through the service:
    await expect(inScope(() => editCriterion({
      rubricId: id, criterionId, patch: { name: 'Changed' }, actor: ACTOR,
    }))).rejects.toThrow(/FROZEN/)

    // And bypassing the service entirely — the trigger refuses it (P8.5):
    await expect(query(
      `UPDATE rubric_criterion SET anchor_4 = 'anything earns 4' WHERE criterion_id = $1`,
      [criterionId])).rejects.toThrow(/immutable/)
    await expect(query(
      `UPDATE rubric SET dimension_weights = '{}'::jsonb WHERE rubric_id = $1`, [id]))
      .rejects.toThrow(/immutable/)
  })

  it('a new version supersedes the previous frozen one (acceptance 3)', async () => {
    const first = await draftRubric()
    await makeApprovable(first)
    await inScope(() => approveRubric(first, ACTOR))
    await inScope(() => freezeRubric(first, ACTOR))

    const second = await draftRubric()
    await makeApprovable(second)
    await inScope(() => approveRubric(second, ACTOR))
    const frozenSecond = await inScope(() => freezeRubric(second, ACTOR))

    expect(frozenSecond.version).toBe(2)
    expect((await loadRubric(first)).status).toBe('SUPERSEDED')

    // Exactly one frozen rubric per challenge.
    const current = await frozenRubric(challengeId)
    expect(current?.rubricId).toBe(String(second))
    expect(await listRubrics(challengeId)).toHaveLength(2)
  })

  it('audits generation, approval and freeze', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await inScope(() => approveRubric(id, ACTOR))
    await inScope(() => freezeRubric(id, ACTOR))

    const rows = await query<{ action: string }>(
      `SELECT action FROM audit_event WHERE subject_type = 'rubric' ORDER BY event_id`)
    const actions = rows.rows.map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining([
      'rubric.generated', 'rubric.approved', 'rubric.frozen',
    ]))
  })
})

describe('publication and export (E02-S08, E09-S04)', () => {
  async function publishedRubric(): Promise<number> {
    const id = await draftRubric()
    await makeApprovable(id)
    await inScope(() => approveRubric(id, ACTOR))
    await inScope(() => freezeRubric(id, ACTOR))
    await inScope(() => publishRubric(id, ACTOR))
    return id
  }

  it('refuses to publish anything that is not FROZEN', async () => {
    const id = await draftRubric()
    await expect(inScope(() => publishRubric(id, ACTOR))).rejects.toThrow(/Only a FROZEN rubric/)
  })

  it('records the publication timestamp (acceptance 3)', async () => {
    const id = await publishedRubric()
    expect((await loadRubric(id)).publishedAt).toBeTruthy()
  })

  it('serves the published rubric by challenge slug, for teams with no account', async () => {
    await publishedRubric()
    const rubric = await publishedRubricBySlug('challenge-alpha')
    expect(rubric.status).toBe('FROZEN')
    expect(rubric.criteria.length).toBeGreaterThan(0)
  })

  it('does not serve an unpublished rubric', async () => {
    const id = await draftRubric()
    await makeApprovable(id)
    await inScope(() => approveRubric(id, ACTOR))
    await inScope(() => freezeRubric(id, ACTOR))
    await expect(publishedRubricBySlug('challenge-alpha')).rejects.toThrow(/No published rubric/)
  })

  it('Markdown export carries criteria, weights, anchors, version and hash (acceptance 1, 2)', async () => {
    const id = await publishedRubric()
    const rubric = await loadRubric(id)
    const md = toMarkdown(rubric, 'Challenge Alpha')

    expect(md).toContain('# Scoring rubric — Challenge Alpha')
    expect(md).toContain(`**Version ${rubric.version}**`)
    expect(md).toContain(rubric.contentHash as string)
    expect(md).toContain('Ingests the feed')
    expect(md).toContain('| 4 | works and is tested |')
    expect(md).toMatch(/Challenge fidelity \| 100%/)
  })

  it('HTML export is self-contained and escapes content safely', async () => {
    const id = await publishedRubric()
    await query(
      `UPDATE rubric SET status = 'APPROVED', frozen_at = NULL, content_hash = NULL
        WHERE rubric_id = $1`, [id]).catch(() => undefined)

    const rubric = await loadRubric(id)
    const html = toHtml(rubric, 'Challenge <Alpha> & "Beta"')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('&lt;Alpha&gt;')
    expect(html).not.toContain('<Alpha>')
    expect(html).toContain('<style>')
  })

  it('publishes the build-declaration rule to teams when Runs is scored (E03-S03 #3)', async () => {
    const id = await publishedRubric()
    const rubric = await loadRubric(id)
    // The fixture puts all weight on fidelity, so Runs is not scored and the rule is omitted.
    expect(toMarkdown(rubric, 'Challenge Alpha')).not.toContain('How your submission will be built')

    const scoresRuns = { ...rubric, dimensionWeights: { ...rubric.dimensionWeights, RUNS: 0.15 } }
    const md = toMarkdown(scoresRuns, 'Challenge Alpha')
    expect(md).toContain('How your submission will be built')
    expect(md).toContain('A Dockerfile')
    expect(md).toContain('A build command')
    expect(md).toMatch(/must be \*\*public\*\*/)

    const html = toHtml(scoresRuns, 'Challenge Alpha')
    expect(html).toContain('How your submission will be built')
  })

  it('audits publication (E09-S04)', async () => {
    await publishedRubric()
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'rubric.published'`)
    expect(rows.rows[0]!.n).toBe(1)
  })
})
