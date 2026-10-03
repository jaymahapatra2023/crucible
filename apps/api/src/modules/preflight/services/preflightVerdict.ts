/**
 * The pure half of pre-flight (E46): what a set of check results means, and how it is told.
 *
 * No I/O, so every rule here is unit-tested without a database. The rule that matters most is
 * in `verdictFor`: UNKNOWN is never rendered as a failure (E46-S01 acceptance 3, P5.1). A probe
 * the harness could not start says nothing about the team.
 */
import type { CheckRecord, CheckStatus, Verdict } from '../db/preflightDb.js'

export const CHECK_KEYS = ['scan', 'provenance', 'substance', 'build', 'run', 'discovery', 'secrets'] as const
export type CheckKey = (typeof CHECK_KEYS)[number]

export const CHECK_LABELS: Record<CheckKey, string> = {
  scan: 'Repository read',
  provenance: 'Commit history',
  substance: 'Substantive code',
  build: 'Build',
  run: 'Runs',
  discovery: 'Description',
  secrets: 'Committed secrets',
}

export function check(
  key: CheckKey, status: CheckStatus, summary: string,
  extra: { remedy?: string | null; detail?: Record<string, unknown> } = {},
): CheckRecord {
  return {
    key, label: CHECK_LABELS[key], status, summary, remedy: extra.remedy ?? null,
    ...(extra.detail && { detail: extra.detail }),
  }
}

/** A check the harness could not complete. Its remedy is always null: nothing for the team. */
export const unknown = (key: CheckKey, reason: string, detail?: Record<string, unknown>) =>
  check(key, 'UNKNOWN', reason, { ...(detail && { detail }) })

export function verdictFor(checks: readonly CheckRecord[]): Verdict {
  if (checks.some((c) => c.status === 'FAIL')) return 'PROBLEMS'
  if (checks.some((c) => c.status === 'UNKNOWN')) return 'UNKNOWN'
  return 'READY'
}

export const MAIL_KEYS: Record<Verdict, string> = {
  READY: 'mail.preflight_ready',
  PROBLEMS: 'mail.preflight_problems',
  UNKNOWN: 'mail.preflight_unknown',
}

/** The keys a team would have to act on, or that could not be checked. Sorted, for comparison. */
export function actionableKeys(checks: readonly CheckRecord[]): string[] {
  return checks.filter((c) => c.status !== 'PASS').map((c) => `${c.key}:${c.status}`).sort()
}

/**
 * Whether two runs would tell the team the same thing.
 *
 * Same commit, same verdict, same set of non-passing checks. A repeat of an identical message
 * is noise a team learns to ignore — and then ignores the one that changed.
 */
export function sameOutcome(
  a: { commitSha: string | null; verdict: Verdict | null; checks: readonly CheckRecord[] },
  b: { commitSha: string | null; verdict: Verdict | null; checks: readonly CheckRecord[] },
): boolean {
  return a.commitSha !== null && a.commitSha === b.commitSha && a.verdict === b.verdict
    && actionableKeys(a.checks).join(',') === actionableKeys(b.checks).join(',')
}

/**
 * The findings block of the email: one paragraph per non-passing check.
 *
 * A FAIL names the problem and what to do. An UNKNOWN says "could not be checked" and the
 * reason, and never a remedy — wording that must stay distinct from failure (E46-S03
 * acceptance 3). PASS lines are left out: a team reads this to learn what to change.
 */
export function findingsText(checks: readonly CheckRecord[]): string {
  const lines: string[] = []
  for (const c of checks) {
    if (c.status === 'FAIL') {
      lines.push(`- ${c.label}: ${c.summary}${c.remedy ? ` What to do: ${c.remedy}` : ''}`)
    } else if (c.status === 'UNKNOWN') {
      lines.push(`- ${c.label}: could not be checked — ${c.summary}`)
    }
  }
  return lines.join('\n\n')
}

/** The shape the probe service reports, reduced to what the two probe checks read. */
export interface ProbeFacts {
  outcome: string
  exitCode: number | null
  stayedUp: boolean
  timedOut: boolean
  resourceExceeded: boolean
  probeError: string | null
  runDurationMs: number
}

/**
 * Build and run, from one probe (E46-S01 acceptance 1).
 *
 * Two checks from one observation, because a team fixes them differently: a build that fails
 * is a Dockerfile or a command; a container that exits is the application. When the build
 * failed, the run is UNKNOWN — it was never attempted, and "your app crashed" would be false.
 */
export function probeChecks(p: ProbeFacts, settleSeconds: number): [CheckRecord, CheckRecord] {
  switch (p.outcome) {
    case 'RUNS':
      return [
        check('build', 'PASS', 'The build completed.'),
        check('run', 'PASS', `The application started and stayed up for ${settleSeconds} seconds.`),
      ]
    case 'BUILDS_ONLY':
      return [
        check('build', 'PASS', 'The build completed.'),
        check('run', 'FAIL',
          `The application exited within ${settleSeconds} seconds of starting`
          + (p.exitCode !== null ? ` (exit code ${p.exitCode}).` : '.'), {
            remedy: 'Start it locally exactly as declared and watch what it does in the first '
              + 'minute — a missing environment variable or a port it cannot bind are the usual '
              + 'causes. Then submit again.',
          }),
      ]
    case 'BUILD_FAILED':
      return [
        check('build', 'FAIL',
          `The build failed${p.exitCode !== null ? ` with exit code ${p.exitCode}` : ''}.`, {
            remedy: 'Build it locally with the same Dockerfile or command you declared, fix the '
              + 'error, and submit again.',
          }),
        unknown('run', 'the build failed, so the application was not started.'),
      ]
    case 'TIMED_OUT':
      // Which step ran out of time is what the team needs: a run duration of zero means the
      // build never finished, and "your app did not start" would send them to the wrong place.
      return p.runDurationMs === 0
        ? [
          check('build', 'FAIL', 'The build did not finish inside the time allowed.', {
            remedy: 'Make the build faster or smaller — a multi-stage Dockerfile, fewer '
              + 'dependencies — and submit again.',
          }),
          unknown('run', 'the build did not finish, so the application was not started.'),
        ]
        : [
          check('build', 'PASS', 'The build completed.'),
          check('run', 'FAIL', 'The application did not become ready inside the time allowed.', {
            remedy: 'Check it starts promptly with no interactive prompt, then submit again.',
          }),
        ]
    case 'RESOURCE_EXCEEDED':
      return [
        check('build', 'PASS', 'The build completed.'),
        check('run', 'FAIL', 'The application exceeded the memory, CPU or process limit.', {
          remedy: 'Run it under the published sandbox limits and reduce what it uses at '
            + 'start-up, then submit again.',
        }),
      ]
    default:
      // UNSUPPORTED_STACK, PROBE_ERROR, or anything new: the harness, not the team.
      return [
        unknown('build', p.probeError ?? 'the build could not be attempted.'),
        unknown('run', p.probeError ?? 'the application could not be started.'),
      ]
  }
}
