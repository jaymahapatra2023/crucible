/**
 * The questions a coach sheet asks (E51). Pure, so every rule is unit-tested without a database.
 *
 * Each question is derived from something the evaluation recorded and cites it, so a coach can
 * say "the review found X — tell me about it" rather than fishing. Questions never state a
 * score, a rank or a decision: those are confidential until results, and a coach who reads a
 * number aloud has told the team where they stand. What they get is the *finding* and an open
 * question shaped by it.
 *
 * Order is importance for a presentation: did it run, claims that did not check out, the
 * weakest criteria, how much they wrote, where the history looks odd, where two evaluations
 * disagreed, and security observations. Capped at five and every line kept to a sentence,
 * because the sheet is one page per team and a coach has ten minutes.
 */

export interface SheetFacts {
  probe: { outcome: string; gradeReason: string } | null
  conflicts: Array<{ claim: string; claimPath: string; observed: string }>
  /** Criteria with a score, weakest first, already limited by the caller. */
  weakest: Array<{ name: string; dimension: string; rawScore: number; rationale: string; evidence: string | null }>
  originality: { boilerplatePct: number; substantiveLines: number; templates: string[] } | null
  provenanceFlags: Array<{ code: string; message: string }>
  disagreements: Array<{ criterion: string; runA: string; runB: string }>
  security: Array<{ label: string; summary: string; path: string | null }>
  lowestPrinciple: { name: string; rationale: string } | null
  nonCompliant: Array<{ name: string; rationale: string }>
}

export interface CoachQuestion {
  /** One of a fixed set, so the UI can group and a test can name what was asked. */
  topic: 'RUN' | 'CLAIM' | 'CRITERION' | 'ORIGINALITY' | 'PROVENANCE' | 'DISAGREEMENT' | 'SECURITY' | 'PRINCIPLE' | 'STANDARD'
  /** What the evaluation found, in a sentence a coach can read aloud. */
  because: string
  /** The open question to ask. */
  ask: string
  /** Where to point, when there is somewhere. */
  evidence: string | null
}

export const MAX_QUESTIONS = 5
/** Above this share of template or generated code, ask what they wrote themselves. */
export const BOILERPLATE_ASK_PCT = 50

export function coachQuestions(f: SheetFacts): CoachQuestion[] {
  const out: CoachQuestion[] = []
  const add = (q: CoachQuestion) => { if (out.length < MAX_QUESTIONS) out.push(q) }

  if (f.probe && f.probe.outcome !== 'RUNS') {
    add(runQuestion(f.probe))
  }
  for (const c of f.conflicts.slice(0, 1)) {
    add({
      topic: 'CLAIM', because: brief(`The documentation says "${c.claim}", but the code did not show it: ${c.observed}`),
      ask: 'Can you show me where that is implemented, or is it planned rather than done?',
      evidence: c.claimPath,
    })
  }
  for (const w of f.weakest.slice(0, 2)) {
    add({
      topic: 'CRITERION', because: brief(`On "${w.name}" the evaluation noted: ${w.rationale}`),
      ask: `How did you approach ${w.name.toLowerCase()}, and what would you do next on it?`,
      evidence: w.evidence,
    })
  }
  if (f.originality && f.originality.boilerplatePct >= BOILERPLATE_ASK_PCT) {
    const templates = f.originality.templates.length > 0 ? ` (${f.originality.templates.join(', ')})` : ''
    add({
      topic: 'ORIGINALITY',
      because: `About ${Math.round(f.originality.boilerplatePct)}% of the code appears generated or template${templates}; `
        + `${f.originality.substantiveLines} lines look written by the team.`,
      ask: 'Which parts did you write yourselves, and what did you change in the generated parts?',
      evidence: null,
    })
  }
  for (const p of f.provenanceFlags.slice(0, 1)) {
    add({
      topic: 'PROVENANCE', because: brief(p.message),
      ask: 'Walk me through how the work was built up over the event — what existed before it started?',
      evidence: null,
    })
  }
  for (const d of f.disagreements.slice(0, 1)) {
    add({
      topic: 'DISAGREEMENT', because: brief(`Two independent evaluations read "${d.criterion}" differently: one said ${d.runA}; the other ${d.runB}.`),
      ask: `Tell me about ${d.criterion.toLowerCase()} — the reviewers were not sure what to make of it.`,
      evidence: null,
    })
  }
  for (const s of f.security.slice(0, 1)) {
    add({
      topic: 'SECURITY', because: brief(`${s.label}: ${s.summary}`),
      ask: 'How does the application handle that, and what would you harden first?',
      evidence: s.path,
    })
  }
  if (f.lowestPrinciple) {
    add({
      topic: 'PRINCIPLE', because: brief(`On the principle "${f.lowestPrinciple.name}": ${f.lowestPrinciple.rationale}`),
      ask: 'What trade-off did you make there, and would you make it again?', evidence: null,
    })
  }
  for (const s of f.nonCompliant.slice(0, 1)) {
    add({
      topic: 'STANDARD', because: brief(`Against the standard "${s.name}": ${s.rationale}`),
      ask: 'Was that a deliberate choice for the weekend, or something you would fix?', evidence: null,
    })
  }
  return out
}

function runQuestion(probe: { outcome: string; gradeReason: string }): CoachQuestion {
  const because: Record<string, string> = {
    BUILD_FAILED: 'The application did not build in the evaluation sandbox.',
    BUILDS_ONLY: 'The application built but exited shortly after starting.',
    TIMED_OUT: 'The application did not become ready inside the time allowed.',
    RESOURCE_EXCEEDED: 'The application exceeded the sandbox memory, CPU or process limits.',
    UNSUPPORTED_STACK: 'The evaluation could not build this stack, so nothing was observed running.',
    PROBE_ERROR: 'The evaluation harness could not attempt to run it — not the team\'s doing.',
  }
  const harness = probe.outcome === 'UNSUPPORTED_STACK' || probe.outcome === 'PROBE_ERROR'
  return {
    topic: 'RUN',
    because: `${because[probe.outcome] ?? ''} ${harness ? '' : brief(probe.gradeReason)}`.trim(),
    ask: harness
      ? 'Can you run it live for me, and tell me what it needs to start?'
      : 'Can you run it live for me? What does it need that was not in the declared build?',
    evidence: null,
  }
}

/** The two or three things a coach can open with, so the conversation does not start on a fault. */
export function coachStrengths(strongest: Array<{ name: string; rationale: string }>): string[] {
  return strongest.slice(0, 2).map((s) => `${s.name}: ${brief(s.rationale)}`)
}

/** The first sentence, at most ~140 characters: a sheet line, not a paragraph. */
export function brief(text: string, max = 140): string {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? ''
  return first.length <= max ? first : first.slice(0, max - 1).trimEnd() + '…'
}
