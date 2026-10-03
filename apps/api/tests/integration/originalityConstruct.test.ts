/**
 * What the ORIGINALITY dimension actually asks (E35).
 *
 * The dimension was built to measure PROVENANCE — how much of the work was the team's own —
 * while the judging criteria ask about INVENTIVENESS. Calibration found ρ 0.006 for it against
 * 0.708 for engineering quality over the same eleven repositories, which is what measuring a
 * different construct from your raters looks like.
 *
 * These tests pin the new construct in the places a reader would have to change to undo it. They
 * are deliberately about WORDING, because on this dimension the wording is the measurement: the
 * prompt and the evidence specification are the whole of what the model is asked.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { query } from '../../src/db/pool.js'

const templates = async (active: boolean) => {
  const res = await query<{ version: number; role: string; body: string }>(
    `SELECT version, role, body FROM llm_prompt_template
      WHERE call_key = 'scoring.originality' AND active = $1 ORDER BY role`, [active])
  return res.rows
}

beforeEach(async () => { await resetDatabase() })

describe('the active prompt asks about the approach', () => {
  it('asks how inventive the approach is, not how much the team wrote', async () => {
    const [system] = (await templates(true)).filter((t) => t.role === 'system')
    expect(system?.version).toBe(2)
    expect(system?.body).toMatch(/how INVENTIVE/)
    expect(system?.body).not.toMatch(/how much of a hackathon submission is the team's own work/)
  })

  it('tells the model that volume and novel dependencies are NOT inventiveness', async () => {
    // The two failure modes this construct invites: rewarding a long submission, and rewarding a
    // README that name-drops a library the team barely used.
    const [system] = (await templates(true)).filter((t) => t.role === 'system')
    expect(system?.body).toMatch(/Volume\./)
    expect(system?.body).toMatch(/dependency, not an idea/)
    expect(system?.body).toMatch(/Complexity\./)
  })

  it('makes the measurements BOUND the judgement rather than be it', async () => {
    const [system] = (await templates(true)).filter((t) => t.role === 'system')
    expect(system?.body).toMatch(/They BOUND your judgement; they are not the judgement/)
    // The one direction they legitimately constrain: nothing written means nothing to judge.
    expect(system?.body).toMatch(/cannot demonstrate an inventive approach/)
  })

  it('still refuses to let assembly facts become an accusation', async () => {
    // Carried over from version 1 deliberately. The construct changed; the restraint should not.
    const [system] = (await templates(true)).filter((t) => t.role === 'system')
    expect(system?.body).toMatch(/exceeds what they support/)
    expect(system?.body).toMatch(/Never treat a recognised generator/)
  })

  it('keeps "cannot tell" distinct from "nothing interesting"', async () => {
    const [system] = (await templates(true)).filter((t) => t.role === 'system')
    expect(system?.body).toMatch(/insufficient_evidence/)
    expect(system?.body).toMatch(/different findings/)
  })
})

describe('version 1 is superseded, not erased', () => {
  it('keeps the old prompt inactive and readable, because scores were produced under it', async () => {
    const old = await templates(false)
    expect(old.filter((t) => t.version === 1)).toHaveLength(2)
    expect(old.find((t) => t.role === 'system')?.body)
      .toMatch(/how much of a hackathon submission is the team's own work/)
  })

  it('has exactly one active template per role', async () => {
    const active = await templates(true)
    expect(active.map((t) => t.role).sort()).toEqual(['system', 'user'])
    expect(active.every((t) => t.version === 2)).toBe(true)
  })
})

describe('what E35 deliberately did NOT change', () => {
  it('leaves the dimension advisory — that is a committee decision, not a migration', async () => {
    const { ADVISORY_DIMENSIONS } = await import('@crucible/rubric')
    expect(ADVISORY_DIMENSIONS).toContain('ORIGINALITY')
  })

  it('keeps the dimension name, so nothing downstream had to be renamed', async () => {
    const { DIMENSIONS } = await import('@crucible/rubric')
    expect(DIMENSIONS).toContain('ORIGINALITY')
  })
})
