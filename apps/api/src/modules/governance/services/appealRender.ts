/**
 * Rendering the appeal packet as a readable document (E09-S02 acceptance 2).
 *
 * The audience is a team who did not present and wants to know why — possibly with a manager
 * beside them, possibly annoyed, and without access to this system. So the document explains its
 * own vocabulary as it goes: what a dimension is, why a criterion has no score, what "advisory"
 * means, and what the system did and did not decide.
 *
 * The most important sentences here are the ones that limit the claims. A packet that presents
 * numbers without saying how they were produced invites an argument about the numbers; one that
 * says plainly "this was excluded because nobody could evidence it, not because you scored zero"
 * answers the question that was actually being asked.
 */
import type { PacketData } from './appealPacket.js'

const NON_SCORE_TEXT: Record<string, string> = {
  INSUFFICIENT_EVIDENCE:
    'Not scored — the files we read did not let this criterion be judged either way. '
    + 'This is NOT a score of zero: the criterion was removed from the average entirely, so it '
    + 'neither helped nor harmed the total.',
  SCORING_FAILED:
    'Not scored — the scoring step failed for technical reasons on our side. This says nothing '
    + 'about the submission, and the criterion was removed from the average rather than counted '
    + 'as zero.',
  NOT_APPLICABLE:
    'Not applicable to this submission, so it was removed from the average.',
}

export function renderPacket(d: PacketData): string {
  return [
    header(d),
    summary(d),
    dimensionSection(d),
    criteriaSection(d),
    buildSection(d),
    discoverySection(d),
    provenanceSection(d),
    flagSection(d),
    decisionSection(d),
    trailSection(d),
    footer(),
  ].join('\n\n')
}

function header(d: PacketData): string {
  return [
    `# Evaluation record — ${d.submission.team_name}`,
    '',
    `Generated ${d.generatedAt}.`,
    '',
    'This document contains everything Crucible recorded about this submission: the standard it',
    'was judged against, every score with the evidence behind it, every caveat the system raised,',
    'and the decision a person took. It is self-contained — nothing here requires access to the',
    'system to check.',
  ].join('\n')
}

function summary(d: PacketData): string {
  const rows = [
    ['Team', d.submission.team_name],
    ['Challenge', String(d.submission.challenge_id)],
    ['Repository', d.submission.repo_url],
    ['Commit judged', d.submission.locked_commit_sha ?? 'not recorded'],
    ['Scoring run', `#${d.run?.run_index_id} (run ${d.run?.run_index} of the two)`],
    ['Rubric', `version ${d.rubric.version}, hash ${d.rubric.contentHash ?? 'unrecorded'}`],
    ['Composite', d.ranking ? Number(d.ranking.composite).toFixed(1) : 'not ranked'],
    ['Rank overall', d.ranking ? String(d.ranking.rank_global) : 'not ranked'],
    ['Rank within challenge', d.ranking ? String(d.ranking.rank_in_challenge) : 'not ranked'],
  ]

  const caveats: string[] = []
  if (d.ranking?.partial) {
    caveats.push(
      'Some part of this submission could not be scored, so its composite was calculated from '
      + 'less evidence than a fully-scored one. The unscored parts were excluded from the '
      + 'average, not counted as zero.')
  }
  if (d.ranking?.normalisation_method === 'ABSOLUTE_FALLBACK') {
    caveats.push(
      `This challenge had ${d.ranking.cohort_size} submissions, too few to compare fidelity `
      + 'scores within the cohort, so the raw score was used unchanged.')
  }
  if (d.ranking?.tied) {
    caveats.push(
      'This submission shares its composite with another. The order between tied submissions is '
      + 'arbitrary and was not used to decide anything.')
  }

  return [
    '## Summary',
    '',
    ...rows.map(([k, v]) => `- **${k}:** ${v}`),
    ...(caveats.length > 0 ? ['', '### Caveats on these figures', '', ...caveats.map((c) => `- ${c}`)] : []),
  ].join('\n')
}

function dimensionSection(d: PacketData): string {
  const lines = d.dimensions.map((dim) => {
    const name = dim.dimension.replace(/_/g, ' ').toLowerCase()
    const weight = `${Math.round(Number(dim.weight) * 100)}% of the total`
    if (dim.score === null) {
      return `- **${name}** — not scored (${weight}). Excluded from the composite entirely.`
    }
    const partial = dim.data_quality === 'PARTIAL'
      ? ` Scored from ${dim.scored_count} of ${dim.total_count} criteria; the rest could not be judged and were excluded.`
      : ''
    return `- **${name}** — ${Number(dim.score).toFixed(1)} out of 100 (${weight}).${partial}`
  })

  return [
    '## Scores by dimension',
    '',
    'Each dimension is scored 0–100 and contributes to the composite by the weight shown. A',
    'dimension nobody could score is left out of the calculation rather than counted as zero.',
    '',
    ...lines,
    ...(d.ranking?.fidelity_raw !== null && d.ranking?.fidelity_raw !== undefined ? [
      '',
      `Challenge fidelity was also recorded before any comparison: **${Number(d.ranking.fidelity_raw).toFixed(1)}**`,
      'out of 100. That raw figure is kept precisely so it can be checked independently of how it',
      'compared with other submissions.',
    ] : []),
  ].join('\n')
}

function criteriaSection(d: PacketData): string {
  const byCriterion = new Map(d.rubric.criteria.map((c) => [String(c.criterionId), c]))

  const blocks = d.criteria.map((score) => {
    const criterion = byCriterion.get(String(score.criterion_id))
    const heading = `### ${criterion?.name ?? `Criterion ${score.criterion_id}`}`

    const verdict = score.raw_score === null
      ? NON_SCORE_TEXT[score.non_score ?? ''] ?? 'Not scored.'
      : `**${score.raw_score} out of 4.**`

    const anchors = criterion
      ? [
          '',
          'The four-point scale used for this criterion, as approved before scoring began:',
          '',
          ...[0, 1, 2, 3, 4].map((n) =>
            `- **${n}** — ${criterion.anchors[n as 0 | 1 | 2 | 3 | 4]}`),
        ]
      : []

    const evidence = score.evidence.length === 0
      ? ['', '_No code was cited for this criterion._']
      : [
          '',
          `Evidence cited. ${citationTally(score.evidence)}`,
          '',
          ...score.evidence.flatMap((e) => [
            `From \`${e.path}\`, lines ${e.lineStart}–${e.lineEnd}:`,
            '',
            '```',
            e.excerpt,
            '```',
            // The verdict of checking this quotation against the commit that was submitted.
            // It STRENGTHENS the packet: it turns "here is a quote" into "here is a quote we
            // checked against your commit" — or says plainly where we could not check.
            ...citationLine(e.verdict, e.verdictReason),
            '',
          ]),
        ]

    return [
      heading,
      '',
      verdict,
      ...(criterion ? ['', criterion.description] : []),
      ...(score.anchor_matched ? ['', `Matched: _${score.anchor_matched}_`] : []),
      '',
      `**Reasoning:** ${score.rationale}`,
      ...anchors,
      ...evidence,
      ...(score.context_truncated ? [
        '',
        '_The scorer reached its reading limit for this criterion, so it may not have seen every',
        'relevant file._',
      ] : []),
    ].join('\n')
  })

  return ['## Every criterion, in full', '', ...blocks].join('\n\n')
}

function buildSection(d: PacketData): string {
  if (!d.probe) {
    return [
      '## Build',
      '',
      'This submission was never built, so whether it runs is unknown. The build dimension was',
      'left out of the composite rather than scored zero.',
    ].join('\n')
  }

  return [
    '## Build',
    '',
    `- **Result:** ${d.probe.runs_grade}`,
    `- **Why:** ${d.probe.grade_reason}`,
    `- **Method:** ${d.probe.outcome}`,
    '',
    ...(d.probe.outcome === 'UNSUPPORTED_STACK' ? [
      'Crucible had no build recipe for this stack. That is a limitation of our system, not a',
      'fault in the work, and the build dimension was excluded rather than scored zero.',
    ] : []),
  ].join('\n')
}

/**
 * What discovery told the evaluators, where a pass informed this run.
 *
 * Labelled as CONTEXT, not evidence, in the same terms the prompt uses — so the packet cannot
 * imply a finding carried more weight than it did. Where no pass informed the run it says so
 * plainly rather than omitting the section: an omission reads as "there was nothing".
 */
function discoverySection(d: PacketData): string {
  if (d.discoveryDigest === '') {
    return [
      '## What the evaluators were told about your code',
      '',
      'No discovery pass was run on this submission, so the principles and standards',
      'assessments were made from the source excerpts alone. That is not a deficiency in your',
      'work and nothing was scored down for it.',
    ].join('\n')
  }

  return [
    '## What the evaluators were told about your code',
    '',
    'Alongside the source excerpts quoted above, the principles and standards assessments were',
    'given the summary below — a map of what a separate pass found in your repository. It is',
    'CONTEXT, not evidence: every judgement still rests on the excerpts, and anything recorded',
    'as NOT DETERMINED means the pass could not read enough to answer, never that your',
    'submission lacks it.',
    '',
    '```',
    d.discoveryDigest,
    '```',
  ].join('\n')
}

function provenanceSection(d: PacketData): string {
  if (d.provenance.flags.length === 0) {
    return ['## Commit history', '', 'Nothing in the commit history was flagged for review.'].join('\n')
  }

  // Whether a person actually looked is the part a team most needs. A packet that reported the
  // flag without the conclusion would leave them reading a suspicion nobody ever answered.
  const outcome = d.provenance.resolved
    ? [
        '',
        `**A person reviewed this and concluded:** ${d.provenance.resolutionReason}`,
      ]
    : [
        '',
        '_No conclusion was recorded against these observations. They were raised for a person',
        'to look at, and they did not exclude you from anything._',
      ]

  return [
    '## Commit history',
    '',
    'These observations were raised for a person to look at. None of them is a finding, and none',
    'of them excluded anyone:',
    '',
    ...d.provenance.flags.map((p) => `- ${p.message}`),
    ...outcome,
  ].join('\n')
}

function flagSection(d: PacketData): string {
  if (d.flags.length === 0) {
    return ['## Caveats raised', '', 'No automated caveats were raised for this submission.'].join('\n')
  }

  return [
    '## Caveats raised',
    '',
    'Things the system could not resolve on its own. A dismissed caveat was reviewed by a person,',
    'whose reason is recorded beside it.',
    '',
    ...d.flags.map((f) => [
      `- ${f.message}`,
      f.dismissed
        ? `  - _Reviewed by ${f.dismissed_by}: ${f.dismissal_reason}_`
        : '  - _Not dismissed._',
    ].join('\n')),
  ].join('\n')
}

function decisionSection(d: PacketData): string {
  if (!d.decision) {
    return [
      '## Decision',
      '',
      'No decision was recorded for this submission. Crucible does not select or eliminate',
      'anyone — it produces a ranked list and a set of caveats, and people decide.',
    ].join('\n')
  }

  return [
    '## Decision',
    '',
    `- **Outcome:** ${d.decision.decision}`,
    `- **Decided by:** ${d.decision.decided_by}`,
    `- **When:** ${d.decision.decided_at.toISOString()}`,
    `- **Rank at the time:** ${d.decision.rank_at_decision ?? 'not recorded'}`,
    '',
    `**Reason given:** ${d.decision.reason}`,
    '',
    'This decision was made by a person. The scores above informed it; they did not make it.',
  ].join('\n')
}

function trailSection(d: PacketData): string {
  if (d.auditTrail.length === 0) return ['## Record of actions', '', 'No actions recorded.'].join('\n')

  return [
    '## Record of actions',
    '',
    'Every recorded action affecting this submission, oldest first. This log cannot be edited or',
    'deleted — the database refuses both.',
    '',
    ...[...d.auditTrail].reverse().map((e) =>
      `- ${e.at.toISOString()} — \`${e.action}\` by ${e.actor}`),
  ].join('\n')
}

function footer(): string {
  return [
    '---',
    '',
    '### How to read this document',
    '',
    'Crucible scores submissions against a rubric that was written, reviewed and frozen before',
    'scoring began. It produces a ranked list and a set of caveats for a committee to work',
    'through. **It does not select or eliminate anyone**: every inclusion and exclusion above was',
    'a decision taken by a named person, with the reason they gave recorded beside it.',
    '',
    'Where a criterion has no score, it was excluded from the calculation rather than counted as',
    'zero. Where a dimension is missing, the composite was calculated without it. Neither case',
    'means the submission scored badly on that point; it means we could not judge it, and we have',
    'said so rather than guessing.',
    '',
    'If any figure here appears wrong, the evidence each one rests on is quoted above and can be',
    'checked against the repository at the commit named in the summary.',
  ].join('\n')
}

/**
 * How much of a criterion's evidence was checkable, in one line.
 *
 * Derived from the stored verdicts rather than stored separately: two records of the same fact
 * drift, and the verdicts are what a reader can check for themselves.
 */
function citationTally(
  evidence: ReadonlyArray<{ verdict?: string }>,
): string {
  const checked = evidence.filter((e) => e.verdict !== undefined)
  if (checked.length === 0) {
    return 'These citations predate checking against the source.'
  }
  const verified = checked.filter((e) => e.verdict === 'VERIFIED').length
  const outside = checked.filter((e) => e.verdict === 'UNVERIFIABLE').length
  const tail = outside > 0
    ? ` ${outside} could not be checked because the file was outside what our scan read.`
    : ''
  return `${verified} of ${evidence.length} were found in the commit you submitted.${tail}`
}

/**
 * What checking a citation found, worded for the team reading it.
 *
 * `UNVERIFIABLE` is phrased as a statement about our reading, never as doubt about them —
 * because that is exactly what it is: a file our scan budget did not reach.
 */
function citationLine(verdict: string | undefined, reason: string | undefined): string[] {
  if (verdict === 'VERIFIED') {
    return ['_Checked: this text is in the commit you submitted, at the lines shown._']
  }
  if (verdict === 'UNVERIFIABLE') {
    // One entry, not two: these are joined with a newline, and splitting the sentence put a
    // line break in the middle of "That is a / limit of our reading".
    return [
      '_We could not check this quotation: the file was outside what our scan read. That is '
      + `a limit of our reading, not a doubt about your work.${reason ? ` (${reason})` : ''}_`,
    ]
  }
  // No verdict recorded: this score predates citation checking. Say so rather than implying
  // a check happened.
  return verdict === undefined
    ? ['_This score was taken before citations were checked against the source._']
    : [`_Checking flagged this citation: ${reason ?? verdict}._`]
}
