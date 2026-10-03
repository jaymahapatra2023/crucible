/**
 * The go/no-go gate (E11-S03).
 *
 * The epic's goal is "establish, before the event, whether this system is fit to eliminate
 * teams", and this is where that question gets an answer. Three properties carry it:
 *
 *  - **The criteria are written down first.** Enforced by `generateReport`, which refuses to run
 *    without them, and by an append-only table so a threshold cannot be edited once the number
 *    it has to clear is known.
 *  - **The decision is a person's**, with a rationale, recorded either way. "Why did you proceed"
 *    is as much a question as "why did you stop".
 *  - **A NO_GO actually stops ranking.** Acceptance 3 says the fallback is fully human judging
 *    and the system may then be used "for evidence gathering only, not for ranking". That is a
 *    behaviour, not a paragraph, so `assertRankingPermitted` refuses and E07's ranking calls it.
 *
 * No decision at all is treated as NO_GO. An uncalibrated system being usable by default is the
 * exact failure this story exists to prevent.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { captureRunPin } from '../../platform/services/configService.js'
import { comparePins, describeDrift, type RunPin } from '../../../lib/runScope.js'
import { isEnabled } from '../../platform/services/configService.js'
import {
  insertCriteria, insertDecision, latestGateDecision, selectReport,
  type CriteriaRow, type DecisionRow, type GateStatusRow, type ReportRow,
} from '../db/gateDb.js'

const log = createLogger('calibration', 'gate')

export type Verdict = 'GO' | 'NO_GO'

export interface GateAssessment {
  /** What the numbers say against the criteria. The DECISION is still a person's. */
  suggested: Verdict
  reasons: string[]
  met: {
    correlation: boolean
    disagreements: boolean
    variance: boolean
  }
}

export async function recordCriteria(input: {
  goldenSetId: number
  minRankCorrelation: number
  maxMaterialDisagreements: number
  materialRankGap: number
  maxRunVariance: number
  fallbackPlan: string
  notes: string
  actor: string
}): Promise<CriteriaRow> {
  const criteria = await insertCriteria({ ...input, recordedBy: input.actor })

  await recordAudit({
    actor: input.actor, action: 'calibration.gate_criteria_recorded',
    subjectType: 'golden_set', subjectId: String(input.goldenSetId),
    payload: {
      criteriaId: criteria.criteria_id,
      minRankCorrelation: input.minRankCorrelation,
      maxMaterialDisagreements: input.maxMaterialDisagreements,
      maxRunVariance: input.maxRunVariance,
    },
  })
  log.info('gate criteria recorded', {
    goldenSetId: input.goldenSetId, criteriaId: criteria.criteria_id,
  })
  return criteria
}

/**
 * What the criteria say about a report.
 *
 * Deliberately called `suggested`. The system evaluates its own thresholds and stops there; a
 * function that returned "the decision" would be the machine deciding whether the machine is fit
 * to decide, which is not a thing this codebase is permitted to do.
 */
export function assess(report: ReportRow, criteria: CriteriaRow): GateAssessment {
  const reasons: string[] = []

  // A correlation that could not be computed is a FAILURE, not a pass by omission: it means the
  // comparison could not be made, and an uncomparable system is not a calibrated one.
  const correlationMet = report.rank_correlation !== null
    && Number(report.rank_correlation) >= Number(criteria.min_rank_correlation)
  if (report.rank_correlation === null) {
    reasons.push(
      `Rank correlation could not be computed${report.correlation_note ? `: ${report.correlation_note}` : '.'} ` +
      `Without it there is no evidence the machine orders work as a person does.`)
  } else if (!correlationMet) {
    reasons.push(
      `Rank correlation is ${report.rank_correlation} over ${report.sample_size} repositories, ` +
      `below the ${criteria.min_rank_correlation} required.`)
  }

  const disagreementsMet =
    report.material_disagreements <= criteria.max_material_disagreements
  if (!disagreementsMet) {
    reasons.push(
      `${report.material_disagreements} material disagreements, above the ` +
      `${criteria.max_material_disagreements} allowed. Each is a repository the machine and a ` +
      `person placed at least ${criteria.material_rank_gap} positions apart.`)
  }

  // Unmeasured variance does not fail the gate: the second run may legitimately not have been
  // done yet. It is reported as a gap rather than counted as a pass.
  const varianceMet = report.max_run_variance === null
    || Number(report.max_run_variance) <= Number(criteria.max_run_variance)
  if (report.max_run_variance === null) {
    reasons.push(
      'Run-to-run variance was not measured, so the system’s consistency with itself is ' +
      'unknown. Score the golden set twice before deciding.')
  } else if (!varianceMet) {
    reasons.push(
      `Run-to-run variance reaches ${report.max_run_variance} points, above the ` +
      `${criteria.max_run_variance} allowed. The machine disagrees with itself by more than the ` +
      `committee accepted.`)
  }

  const suggested: Verdict =
    correlationMet && disagreementsMet && varianceMet ? 'GO' : 'NO_GO'

  if (suggested === 'GO') {
    reasons.push(
      `Every recorded criterion is met: correlation ${report.rank_correlation} over ` +
      `${report.sample_size} repositories, ${report.material_disagreements} material ` +
      `disagreement(s), variance ${report.max_run_variance ?? 'unmeasured'}.`)
  }

  return {
    suggested,
    reasons,
    met: {
      correlation: correlationMet,
      disagreements: disagreementsMet,
      variance: varianceMet,
    },
  }
}

/** Record the committee's decision. The rationale is mandatory either way. */
export async function decide(input: {
  reportId: number
  decision: Verdict
  rationale: string
  actor: string
}): Promise<DecisionRow> {
  const report = await selectReport(input.reportId)
  if (!report) {
    throw new AppError('NOT_FOUND', `Calibration report ${input.reportId} was not found.`)
  }

  const decision = await insertDecision({
    reportId: input.reportId,
    decision: input.decision,
    rationale: input.rationale,
    decidedBy: input.actor,
    // A gate is evidence about the configuration it was measured under, and nothing else. A
    // ranking computed under a materially different one is not covered by this verdict, and the
    // only way to say so later is to have written the configuration down now.
    pinnedConfig: await captureRunPin(),
  })

  await recordAudit({
    actor: input.actor, action: 'calibration.gate_decided',
    subjectType: 'calibration_report', subjectId: String(input.reportId),
    payload: {
      decision: input.decision,
      rationale: input.rationale,
      rankCorrelation: report.rank_correlation,
      materialDisagreements: report.material_disagreements,
    },
  })

  log.warn('go/no-go decision recorded', {
    reportId: input.reportId, decision: input.decision, actor: input.actor,
  })
  return decision
}

export interface GateCoverage extends GateStatusRow {
  /**
   * Whether the settings now in force are the ones this verdict was measured under.
   *
   * Three states, not two. `null` means the decision predates configuration recording, so we do
   * not KNOW what it was measured under — which is a different and quieter thing than knowing
   * the settings have moved. Collapsing them would either cry wolf on every historical decision
   * or claim a coverage we cannot support.
   */
  coversCurrentConfig: boolean | null
  configNote: string
}

/**
 * The gate verdict, and whether it still applies.
 *
 * A passed gate vouches for the configuration it was measured under. Change a cut line or a
 * context budget afterwards and the verdict is still recorded as GO — reading it as blanket
 * permission is the mistake this guards against, so the answer carries its own scope.
 */
export async function gateStatus(): Promise<GateCoverage | null> {
  const status = await latestGateDecision()
  if (!status) return null

  const recorded = (status.pinned_config ?? null) as RunPin | null
  if (!recorded || Object.keys(recorded.config ?? {}).length === 0) {
    return {
      ...status,
      coversCurrentConfig: null,
      configNote: 'This decision was taken before the configuration behind a gate was recorded, '
        + 'so which settings it was measured under is not known.',
    }
  }

  const drift = comparePins(recorded, await captureRunPin())
  return {
    ...status,
    coversCurrentConfig: drift.alike,
    configNote: drift.alike
      ? 'The settings now in force are the ones this decision was measured under.'
      : `${describeDrift(drift)} This verdict was measured under different settings and does `
        + `not vouch for a run under the current ones.`,
  }
}

/**
 * Refuse to rank unless the gate has been passed (acceptance 3).
 *
 * This is the enforcement. Without it, "the system may be used for evidence gathering only" is a
 * sentence in a document that the next person to click Compute Ranking will not have read.
 *
 * Deliberately bypassable through configuration, and deliberately noisy about it: a team
 * developing or rehearsing needs to rank without a calibrated gate, and the honest way to allow
 * that is a flag an operator must turn on, not a check that quietly passes when unconfigured.
 */
export async function assertRankingPermitted(): Promise<void> {
  if (await isEnabled('feature.calibration.bypass_gate')) {
    log.warn('ranking permitted WITHOUT a passed calibration gate; the bypass flag is on')
    return
  }

  const status = await gateStatus()

  if (!status) {
    throw new AppError(
      'PRECONDITION_FAILED',
      'No go/no-go decision has been recorded, so this system has not been shown fit to rank ' +
        'submissions. Calibrate it against a golden set and record a decision first — an ' +
        'uncalibrated system must not be usable by default (E11-S03). Scanning, probing and ' +
        'scoring remain available for gathering evidence; only ranking is refused.',
    )
  }

  if (status.decision === 'NO_GO') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `The calibration gate was failed on ${status.decided_at.toISOString().slice(0, 10)} by ` +
        `${status.decided_by}, so ranking is disabled. The recorded fallback is: ` +
        `${status.fallback_plan} Evidence gathering — scanning, probing, scoring and the ` +
        `per-team records — remains available.`,
      { details: { decisionId: status.decision_id, rationale: status.rationale } },
    )
  }

  // A GO vouches for the system UNDER THE SETTINGS IT WAS MEASURED UNDER (E25).
  //
  // This was surfaced and not enforced: the banner said the verdict did not cover the current
  // configuration while ranking proceeded anyway, which is the shape of defect this system
  // exists to refuse — a recorded fact nobody acts on. Only settings declared
  // `affects_outcome` are compared (E14), so concurrency and cost ceilings still move freely;
  // what cannot move is a weight, a threshold or a cut line.
  if (status.coversCurrentConfig === false) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `The calibration gate was passed on ${status.decided_at.toISOString().slice(0, 10)}, but ` +
        `under different settings. ${status.configNote} Put the settings back, or calibrate ` +
        `again under the ones now in force. Only settings that decide an outcome are compared.`,
      { details: { decisionId: status.decision_id } },
    )
  }

  if (status.coversCurrentConfig === null) {
    // "We do not know what it was measured under" is not "it is fine". The same rule the
    // readiness report keeps, where UNKNOWN does not count as ready.
    throw new AppError(
      'PRECONDITION_FAILED',
      `The calibration gate was passed on ${status.decided_at.toISOString().slice(0, 10)}, but ` +
        `${status.configNote}A verdict that cannot be tied to a configuration cannot vouch for ` +
        `a run under this one. Calibrate again; the decision will record its settings.`,
      { details: { decisionId: status.decision_id } },
    )
  }
}
