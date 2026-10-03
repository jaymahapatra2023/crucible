/**
 * The rules behind a coach sheet (E51): every question comes from a finding, cites it, and never
 * states a score; the sheet is one page, so at most five.
 */
import { describe, expect, it } from 'vitest'
import { BOILERPLATE_ASK_PCT, MAX_QUESTIONS, brief, coachQuestions, coachStrengths, type SheetFacts } from './coachQuestions.js'

const empty: SheetFacts = {
  probe: null, conflicts: [], weakest: [], originality: null, provenanceFlags: [], disagreements: [],
  security: [], lowestPrinciple: null, nonCompliant: [],
}

const full: SheetFacts = {
  probe: { outcome: 'BUILD_FAILED', gradeReason: 'npm ci exited 1: missing lockfile.' },
  conflicts: [
    { claim: 'Supports OAuth login', claimPath: 'README.md', observed: 'No OAuth client or callback route was found.' },
    { claim: 'Real-time updates', claimPath: 'README.md', observed: 'No websocket or SSE handler.' },
  ],
  weakest: [
    { name: 'Handles failures without losing work', dimension: 'CHALLENGE_FIDELITY', rawScore: 1, rationale: 'Errors are caught but swallowed. The retry helper is never called.', evidence: 'src/api.ts:40' },
    { name: 'Tests cover the main path', dimension: 'ENGINEERING_QUALITY', rawScore: 2, rationale: 'Two tests, both of the health route.', evidence: null },
    { name: 'Clear domain model', dimension: 'ENGINEERING_QUALITY', rawScore: 3, rationale: 'Fine.', evidence: null },
  ],
  originality: { boilerplatePct: 72, substantiveLines: 140, templates: ['Vite starter'] },
  provenanceFlags: [{ code: 'NO_HISTORY', message: 'This submission has no readable git history.' }],
  disagreements: [{ criterion: 'Tests cover the main path', runA: 'scored it 2 of 4', runB: 'scored it 4 of 4' }],
  security: [{ label: 'Secret in source', summary: 'An API key literal in config.ts.', path: 'src/config.ts' }],
  lowestPrinciple: { name: 'Fail loudly', rationale: 'Exceptions are logged and ignored.' },
  nonCompliant: [{ name: 'No secrets in source', rationale: 'A key is committed.' }],
}

describe('what gets asked', () => {
  it('asks nothing when nothing was found, and does not invent a fault', () => {
    expect(coachQuestions(empty)).toEqual([])
  })

  it('leads with whether it ran, then unconfirmed claims, then the weakest criteria — five at most', () => {
    const qs = coachQuestions(full)
    expect(qs).toHaveLength(MAX_QUESTIONS)
    expect(qs.map((q) => q.topic)).toEqual(['RUN', 'CLAIM', 'CRITERION', 'CRITERION', 'ORIGINALITY'])
    expect(qs[0]!.because).toContain('did not build')
    expect(qs[0]!.because).toContain('missing lockfile')
    expect(qs[1]!.evidence).toBe('README.md')
    expect(qs[2]!.evidence).toBe('src/api.ts:40')
    expect(qs[2]!.ask).toContain('handles failures without losing work')
  })

  it('never states a score, rank or decision in what a coach reads aloud', () => {
    for (const q of coachQuestions(full)) {
      expect(q.because).not.toMatch(/\b[0-4] of 4\b|rank|shortlist|composite/i)
      expect(q.ask).not.toMatch(/\b[0-4] of 4\b|rank|shortlist|composite/i)
    }
  })

  it('treats a stack the harness could not build as our problem, not theirs', () => {
    const [q] = coachQuestions({ ...empty, probe: { outcome: 'UNSUPPORTED_STACK', gradeReason: 'No Dockerfile or known manifest.' } })
    expect(q!.because).toContain('could not build this stack')
    expect(q!.because).not.toContain('No Dockerfile')
    expect(q!.ask).toContain('run it live')
  })

  it('does not ask about a run that ran', () => {
    expect(coachQuestions({ ...empty, probe: { outcome: 'RUNS', gradeReason: 'Answered on :3000.' } })).toEqual([])
  })

  it('asks about originality only above the threshold, and names the template', () => {
    expect(coachQuestions({ ...empty, originality: { boilerplatePct: BOILERPLATE_ASK_PCT - 1, substantiveLines: 900, templates: [] } })).toEqual([])
    const [q] = coachQuestions({ ...empty, originality: { boilerplatePct: 72.4, substantiveLines: 140, templates: ['Vite starter'] } })
    expect(q!.because).toBe('About 72% of the code appears generated or template (Vite starter); 140 lines look written by the team.')
  })

  it('fills the tail with disagreement, security, principle and standard when the head is quiet', () => {
    const qs = coachQuestions({ ...full, probe: null, conflicts: [], weakest: [], originality: null })
    expect(qs.map((q) => q.topic)).toEqual(['PROVENANCE', 'DISAGREEMENT', 'SECURITY', 'PRINCIPLE', 'STANDARD'])
    expect(qs[1]!.because).toContain('one said scored it 2 of 4; the other scored it 4 of 4')
    expect(qs[2]!.evidence).toBe('src/config.ts')
  })
})

describe('one page', () => {
  it('keeps every "because" to a sentence', () => {
    const facts = { ...full, weakest: [{ ...full.weakest[0]!, rationale: 'First sentence here. Second sentence that would run on and on. Third.' }] }
    const q = coachQuestions(facts).find((x) => x.topic === 'CRITERION')!
    expect(q.because).toBe('On "Handles failures without losing work" the evaluation noted: First sentence here.')
  })

  it('truncates a sentence that would not fit a line', () => {
    expect(brief('x'.repeat(200))).toHaveLength(140)
    expect(brief('x'.repeat(200)).endsWith('…')).toBe(true)
    expect(brief('Short.')).toBe('Short.')
    expect(brief('')).toBe('')
  })

  it('opens with two strengths, briefly', () => {
    expect(coachStrengths([
      { name: 'A', rationale: 'Good. Very good indeed.' }, { name: 'B', rationale: 'Fine' }, { name: 'C', rationale: 'Also' },
    ])).toEqual(['A: Good.', 'B: Fine'])
  })
})
