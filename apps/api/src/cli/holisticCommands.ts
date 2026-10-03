/**
 * The holistic-comparison experiment, from a terminal.
 *
 * Two commands. `holistic` evaluates a whole golden set with one model call per repository and no
 * criteria. `compare` puts that ranking beside the per-criterion one and correlates both against
 * the committee's hand ranking, once it exists.
 *
 * Separate from the gate commands because this is not part of the gate. It decides nothing; it
 * exists so a question about the method can be answered with numbers from the reference set.
 */
import { withCorrelation } from '../lib/correlation.js'
import { evaluateSetHolistically } from '../modules/calibration/services/holisticEvaluator.js'
import { compareApproaches } from '../modules/calibration/services/holisticComparison.js'
import { heading, line, table, UsageError, type Args } from './args.js'

const go = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: 'cli-holistic' }, fn)

const rho = (c: { rho: number | null; n: number; note?: string | null }) =>
  c.rho === null ? `—  (${c.note ?? 'not computable'})` : `${c.rho.toFixed(3)}  over ${c.n} entries`

export async function holisticCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required: the golden set to evaluate.')
  const pass = args.number('pass', 1)
  if (pass !== 1 && pass !== 2) {
    throw new UsageError('--pass must be 1 or 2. Two passes measure whether this approach agrees '
      + 'with itself, which is the question that decides whether a single number can be trusted.')
  }
  const actor = args.require('actor', 'who ran it; this is recorded.')

  line(`Evaluating golden set ${setId}, pass ${pass}.`)
  line('One call per repository, the whole repository, no criteria. This is slow.')
  const rows = await go(() => evaluateSetHolistically({
    goldenSetId: setId, passIndex: pass as 1 | 2, actor,
  }))

  heading(`Pass ${pass} — ${rows.length} evaluated`)
  table(['entry', 'overall', 'files', 'bytes', 'cut', 'verdict'], rows.map((r) => [
    String(r.submission_id),
    r.overall === null ? (r.non_score ?? 'none') : `${r.overall}/100`,
    `${r.files_shown}/${r.files_in_scan}`,
    String(r.context_bytes),
    r.context_truncated ? 'yes' : 'no',
    r.verdict.slice(0, 54),
  ]))
  const cost = rows.reduce((sum, r) => sum + Number(r.cost_usd), 0)
  line('')
  line(`cost  $${cost.toFixed(2)}`)
  const noted = rows.filter((r) => r.injection_noted !== null)
  if (noted.length > 0) {
    line('')
    line(`${noted.length} evaluation(s) reported something in the repository that read as an `
      + 'instruction. Worth reading before trusting the score.')
  }
  line('')
  line(`Next:  pnpm calibration compare --set ${setId} --cohort <key> --actor ${actor}`)
}

export async function compareCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')
  const cohortKey = args.require('cohort',
    'the cohort key the per-criterion runs used, so both approaches are read off the same scores.')

  const result = await go(() => compareApproaches({ goldenSetId: setId, cohortKey }))

  heading(`Golden set ${setId} — two approaches over ${result.entries} repositories`)
  table(['per-criterion', 'score', 'holistic', 'score'],
    result.perCriterion.rows.map((pc, i) => {
      const h = result.holistic.rows[i]
      return [
        `${pc.rank}. ${pc.label}`, pc.note,
        h ? `${h.rank}. ${h.label}` : '', h?.note ?? '',
      ]
    }))

  heading('Against the committee')
  if (!result.versusHumans) {
    line('No hand ranking yet, so the question is not decidable. Two or more rankers are needed;')
    line('until then the tables above are two opinions with nothing to check them against.')
  } else {
    table(['approach', 'rank correlation with the humans'], [
      ['per-criterion', rho(result.versusHumans.perCriterion)],
      ['holistic', rho(result.versusHumans.holistic)],
    ])
    line('')
    line(`rankers: ${result.versusHumans.rankers.join(', ')}`)
  }

  heading('Against itself, across two runs')
  table(['approach', 'rank correlation with its own second pass'], [
    ['per-criterion', rho(result.reproducibility.perCriterion)],
    ['holistic', rho(result.reproducibility.holistic)],
  ])

  heading('Against each other')
  line(rho(result.betweenApproaches))
  if (result.widestGaps.length > 0) {
    line('')
    line('Where they disagree most:')
    table(['entry', 'per-criterion', 'holistic', 'places apart'], result.widestGaps.map((g) => [
      g.label, String(g.perCriterionRank), String(g.holisticRank), String(g.gap),
    ]))
  }

  if (result.perCriterion.unscored > 0 || result.holistic.unscored > 0) {
    line('')
    line(`unscored: ${result.perCriterion.unscored} per-criterion, ${result.holistic.unscored} `
      + 'holistic. An unscored entry is ranked last here, which flatters neither approach but is '
      + 'not the same as having been judged.')
  }
}
