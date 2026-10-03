/**
 * Every automated caveat, worded for a person (E08-S03).
 *
 * Acceptance 2 is the whole design of this file: "Each states what it means in plain language,
 * not a code." So the wording lives here, beside the condition that raises it, and is written
 * once. A UI that translates codes into sentences ends up with a second vocabulary, and the two
 * drift until a flag means one thing in the table and another in the detail view.
 *
 * Every message follows the same shape: what was observed, then what it does and does not imply.
 * The second half matters more than the first. "40% of commits fall outside the event window" is
 * a fact that reads as an accusation unless the innocent explanations are attached to it, and a
 * reviewer who acts on the unqualified version is being misled by this system, not by the team.
 *
 * Nothing here excludes anyone. These are things to look at.
 */

export type FlagSeverity = 'ADVISORY' | 'ATTENTION'

export interface ReviewFlag {
  code: string
  severity: FlagSeverity
  message: string
  detail: Record<string, unknown>
}

export interface FlagInputs {
  /** From the persisted scan (E04-S04). */
  scan?: { filesAnalysed: number; filesTotal: number; budgetTruncated: boolean } | undefined
  /** Criteria that produced no score, by reason. */
  nonScores?: { insufficient: number; failed: number; total: number } | undefined
  /** From the build probe (E05). */
  probe?: { outcome: string; runsGrade: string; reason: string } | undefined
  /** Provenance observations, already worded by the scanner (E04-S06). */
  provenance?: ReadonlyArray<{ code: string; message: string }> | undefined
  /** How fidelity was normalised, and against how many (E07-S03). */
  normalisation?: { method: string; cohortSize: number; floor: number } | undefined
  /** Disagreement between the two runs (E06-S06). */
  variance?: { delta: number; straddlesCut: boolean; threshold: number } | undefined
  /** Whether removing the advisory dimension would move it across the cut (E06-S05). */
  advisoryDecided?: boolean | undefined
  /**
   * Challenge fidelity against the point below which an entry has probably answered a different
   * question than the brief asked (E51 calibration finding).
   */
  fidelity?: { score: number | null; otherDimensionsMean: number | null; threshold: number } | undefined
}

export function buildReviewFlags(input: FlagInputs): ReviewFlag[] {
  return [
    scanFlag(input.scan),
    evidenceFlag(input.nonScores),
    probeFlag(input.probe),
    normalisationFlag(input.normalisation),
    ...varianceFlags(input.variance),
    advisoryFlag(input.advisoryDecided),
    fidelityFlag(input.fidelity),
    ...provenanceFlags(input.provenance),
  ].filter((f): f is ReviewFlag => f !== null)
}

/**
 * An entry that scores well everywhere except on whether it answered the brief.
 *
 * The composite is a weighted average, so excellence elsewhere offsets a low fidelity score and
 * no choice of weights removes that: calibration showed a well-built entry for the *other*
 * challenge scoring 20 on fidelity and still placing mid-table, because its engineering,
 * principles and runs marks were excellent. A weighted mean cannot express "failing the point
 * disqualifies you", and it should not try — that judgement belongs to a person.
 *
 * So this says what was observed and leaves the decision where it belongs. It is the one caveat
 * that is about the SHAPE of a composite rather than about the evidence behind it.
 *
 * It does NOT claim the entry answered a different question. A low fidelity score has two
 * innocent-to-damning readings — wrong brief, or right brief done badly — and only a reader can
 * tell which. The contrast with the other dimensions is offered when it is large, because that is
 * the signal that distinguishes them, and withheld when it is not.
 */
function fidelityFlag(f: FlagInputs['fidelity']): ReviewFlag | null {
  if (!f || f.score === null || f.score >= f.threshold) return null

  const elsewhere = f.otherDimensionsMean
  const contrast = elsewhere !== null && elsewhere - f.score >= 30
    ? ` It scored ${Math.round(elsewhere)} on average across the other dimensions, so its position `
      + `rests on work the brief did not ask for.`
    : ''

  return {
    code: 'LOW_CHALLENGE_FIDELITY',
    severity: 'ATTENTION',
    message:
      `This entry scored ${Math.round(f.score)} of 100 on challenge fidelity, below the ${f.threshold} `
      + `at which an entry has usually either answered a different question than the brief asked, or `
      + `addressed this one barely.${contrast} The composite is a weighted average, so strength in `
      + `other dimensions offsets this rather than being overridden by it. Read the fidelity criteria `
      + `and their evidence before accepting the position: which of those two it is, and what it `
      + `should cost, is a decision for the committee rather than an arithmetic outcome.`,
    detail: {
      fidelity: f.score, threshold: f.threshold,
      otherDimensionsMean: elsewhere,
    },
  }
}

function scanFlag(scan: FlagInputs['scan']): ReviewFlag | null {
  if (!scan?.budgetTruncated) return null
  return {
    code: 'SCAN_TRUNCATED',
    severity: 'ATTENTION',
    message:
      `The scanner read ${scan.filesAnalysed} of ${scan.filesTotal} files before reaching its ` +
      `budget, so every score for this team was formed from part of the repository. Work in ` +
      `the files that were not read could not count for or against them.`,
    detail: { filesAnalysed: scan.filesAnalysed, filesTotal: scan.filesTotal },
  }
}

function evidenceFlag(nonScores: FlagInputs['nonScores']): ReviewFlag | null {
  if (!nonScores) return null
  const unscored = nonScores.insufficient + nonScores.failed
  if (unscored === 0) return null

  const parts: string[] = []
  if (nonScores.insufficient > 0) {
    parts.push(`${nonScores.insufficient} could not be evidenced from the code that was read`)
  }
  if (nonScores.failed > 0) {
    parts.push(`${nonScores.failed} failed to score for technical reasons`)
  }

  return {
    code: 'INSUFFICIENT_EVIDENCE',
    severity: 'ATTENTION',
    message:
      `${unscored} of ${nonScores.total} criteria produced no score: ${parts.join(', ')}. ` +
      `These were excluded from the averages rather than counted as zero, so this team was ` +
      `ranked on less evidence than a fully-scored one — not marked down.`,
    detail: { ...nonScores },
  }
}

function probeFlag(probe: FlagInputs['probe']): ReviewFlag | null {
  if (!probe) {
    return {
      code: 'NOT_PROBED',
      severity: 'ATTENTION',
      message:
        'This submission was never built, so whether it runs is unknown. The Runs dimension ' +
        'was left out of its composite rather than scored zero.',
      detail: {},
    }
  }

  if (probe.outcome === 'UNSUPPORTED_STACK') {
    return {
      code: 'UNSUPPORTED_STACK',
      severity: 'ATTENTION',
      message:
        `Crucible has no build recipe for this submission's stack, so it was never built. ` +
        `That is a limitation of this system, not a fault in the work: ${probe.reason} The ` +
        `Runs dimension was excluded rather than scored zero.`,
      detail: { outcome: probe.outcome, runsGrade: probe.runsGrade },
    }
  }

  if (probe.outcome === 'PROBE_ERROR') {
    return {
      code: 'PROBE_ERROR',
      severity: 'ATTENTION',
      message:
        `The build harness failed while probing this submission, so whether it runs is still ` +
        `unknown: ${probe.reason} The Runs dimension was excluded rather than scored zero.`,
      detail: { outcome: probe.outcome },
    }
  }

  return null
}

function normalisationFlag(n: FlagInputs['normalisation']): ReviewFlag | null {
  if (!n || n.method === 'PERCENTILE') return null

  if (n.method === 'ABSOLUTE_FALLBACK') {
    return {
      code: 'COHORT_BELOW_FLOOR',
      severity: 'ATTENTION',
      message:
        `This challenge had ${n.cohortSize} submissions, below the ${n.floor} needed to compare ` +
        `fidelity within a cohort, so the raw fidelity score was used unchanged. Its position ` +
        `relative to teams in a larger challenge rests on the rubric's absolute wording rather ` +
        `than on a like-for-like comparison.`,
      detail: { cohortSize: n.cohortSize, floor: n.floor, method: n.method },
    }
  }

  if (n.method === 'DEGENERATE_UNIFORM') {
    return {
      code: 'COHORT_UNIFORM',
      severity: 'ADVISORY',
      message:
        `Every submission in this challenge scored the same on fidelity, so the comparison ` +
        `could not separate them and the raw score was kept. That may be a genuine shared ` +
        `result rather than a scoring failure.`,
      detail: { cohortSize: n.cohortSize, method: n.method },
    }
  }

  return null
}

function varianceFlags(v: FlagInputs['variance']): ReviewFlag[] {
  if (!v) return []
  const flags: ReviewFlag[] = []

  if (v.straddlesCut) {
    flags.push({
      code: 'STRADDLES_CUT',
      severity: 'ATTENTION',
      message:
        'The two scoring runs disagree about whether this team falls inside or outside the cut ' +
        'line. That is the case where the system’s own inconsistency would change the ' +
        'outcome, and it is the reason a person decides rather than the scores.',
      detail: { delta: v.delta },
    })
  }

  if (v.delta > v.threshold) {
    flags.push({
      code: 'RUN_DISAGREEMENT',
      severity: 'ATTENTION',
      message:
        `The two runs produced composites ${v.delta} points apart, more than the ${v.threshold} ` +
        `point tolerance. Both were scored from the same evidence against the same rubric, so ` +
        `the gap measures how reliably this submission could be judged — not how good it is.`,
      detail: { delta: v.delta, threshold: v.threshold },
    })
  }

  return flags
}

function advisoryFlag(decided: FlagInputs['advisoryDecided']): ReviewFlag | null {
  if (!decided) return null
  return {
    code: 'ADVISORY_DECIDED',
    severity: 'ATTENTION',
    message:
      'Removing the advisory originality dimension would move this team across the cut line. ' +
      'Originality is the least reliable thing Crucible measures and carries the lowest weight ' +
      'for that reason; it must not be what decides this on its own.',
    detail: {},
  }
}

function provenanceFlags(flags: FlagInputs['provenance']): ReviewFlag[] {
  // Already worded by the scanner with their innocent explanations attached (E04-S06); passing
  // them through keeps one wording rather than a paraphrase that loses the caveat.
  return (flags ?? []).map((f) => ({
    code: `PROVENANCE_${f.code}`,
    severity: 'ATTENTION' as const,
    message: f.message,
    detail: { provenanceCode: f.code },
  }))
}
