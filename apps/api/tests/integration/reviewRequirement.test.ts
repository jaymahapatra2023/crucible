/**
 * Which artifacts get a Reviewer and a Judge (P4.3, ADR 0004).
 *
 * P4.3 originally read as though every CRITICAL call key followed the Worker / Reviewer / Judge
 * pattern. Four of them — the calls that actually produce scores — never have. That was found
 * while closing G6, recorded as G18, and decided in ADR 0004: Crucible does not review the
 * scoring calls, because the pattern would roughly triple the dominant spend of an evaluation
 * and whether it is needed is what the calibration gate exists to establish.
 *
 * A decision written only in prose is a decision the next CRITICAL call key quietly contradicts.
 * So the set is pinned here, the same way the P8.1 public-route allow-list is pinned: adding a
 * key without a review pass fails a named test and has to be a decision rather than an oversight.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { selectAllRegistrations } from '../../src/modules/llm/db/llmRegistryDb.js'

beforeEach(async () => { await resetDatabase() })

/** The complete set of call keys that carry a review requirement. Changing this is a decision. */
const REVIEWED = ['rubrics.criteria_generate'] as const

/**
 * CRITICAL keys deliberately NOT reviewed, each with the reason it is exempt.
 *
 * Listed individually rather than derived, so that a new CRITICAL key is absent from BOTH lists
 * and fails — which is the point. A test that computed "everything not reviewed" would welcome
 * a new unreviewed key silently.
 */
const EXEMPT: Record<string, string> = {
  'rubrics.criteria_review': 'It IS the reviewer. A review pass does not get its own reviewer.',
  'rubrics.criteria_judge': 'It IS the judge, for the same reason.',
  'rubrics.quality_gate': 'Reads criteria and reports whether each is scoreable. Its output is '
    + 'advisory to a human author, not an artifact anything is judged against.',
  'scoring.criterion': 'ADR 0004 — the cost is concentrated here, and citation verification, '
    + 'semantic validation, the double run and the calibration gate stand in its place.',
  'scoring.engineering': 'ADR 0004 — same reasoning, at dimension level.',
  'scoring.principles': 'ADR 0004 — same reasoning, per declared principle.',
  'scoring.standards': 'ADR 0004 — same reasoning, per declared standard.',
}

describe('the review requirement is declared in exactly one place (P4.3)', () => {
  it('is carried by the registry, and by these keys only', async () => {
    const reviewed = (await selectAllRegistrations())
      .filter((r) => r.requiresReview)
      .map((r) => r.callKey)
      .sort()
    expect(reviewed).toEqual([...REVIEWED].sort())
  })

  it('accounts for EVERY critical key — reviewed, or exempt with a stated reason', async () => {
    // The assertion that actually holds ADR 0004 shut. A CRITICAL key added later appears in
    // neither list and fails here, naming itself.
    const critical = (await selectAllRegistrations())
      .filter((r) => r.criticality === 'CRITICAL')
      .map((r) => r.callKey)

    const unaccounted = critical.filter(
      (key) => !REVIEWED.includes(key as typeof REVIEWED[number]) && EXEMPT[key] === undefined)
    expect(unaccounted).toEqual([])
  })

  it('names the four scoring keys as the exception ADR 0004 records', async () => {
    const registrations = await selectAllRegistrations()
    for (const key of [
      'scoring.criterion', 'scoring.engineering', 'scoring.principles', 'scoring.standards',
    ]) {
      const registration = registrations.find((r) => r.callKey === key)
      expect(registration, key).toBeDefined()
      // CRITICAL is about retry policy, terminality and logging. It is not a synonym for
      // reviewed, and conflating the two is what made P4.3 read as met when it was not.
      expect(registration!.criticality, key).toBe('CRITICAL')
      expect(registration!.requiresReview, key).toBe(false)
    }
  })

  it('keeps the reviewer and judge calls that rubric synthesis actually uses', async () => {
    // The exemption removes a control that was never built. It must not remove one that was.
    const keys = (await selectAllRegistrations()).map((r) => r.callKey)
    expect(keys).toEqual(expect.arrayContaining([
      'rubrics.criteria_review', 'rubrics.criteria_judge',
    ]))
  })

  it('gives every exempt key a reason, not just an entry', async () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, key).toBeGreaterThan(10)
    }
  })
})
