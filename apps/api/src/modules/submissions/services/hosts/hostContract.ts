/**
 * The one contract every repository host implements (P1.5 clause 1).
 *
 * Hosts differ in how they phrase failure: GitHub says "Repository not found" whether a repo is
 * private or absent, GitLab distinguishes them. Interpreting that difference is the host's job,
 * so E03-S02's requirement for a *specific* reason survives adding a host.
 */

export const VALIDATION_STATUSES = [
  'PENDING', 'VALID', 'UNREACHABLE', 'PRIVATE', 'REJECTED',
] as const
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number]

export interface FailureReading {
  status: Exclude<ValidationStatus, 'PENDING' | 'VALID'>
  /** Plain-language reason a team can act on (E03-S02 acceptance 2). */
  detail: string
}

export interface RepoHost {
  readonly name: string
  /** Hostnames this strategy claims. */
  readonly hosts: readonly string[]
  /** Normalise a user-supplied URL to a canonical clone URL, or null if it is not usable. */
  normalise(url: URL): string | null
  /** Turn git's stderr into a specific, actionable reason. */
  readFailure(stderr: string, timedOut: boolean): FailureReading
}

/** Shared reading for the failures every host phrases the same way. */
export function commonFailureReading(stderr: string, timedOut: boolean): FailureReading | null {
  if (timedOut) {
    return {
      status: 'UNREACHABLE',
      detail: 'The repository did not respond in time. It may be very large, or the host may be slow.',
    }
  }
  const s = stderr.toLowerCase()

  if (s.includes('could not resolve host') || s.includes('name or service not known')) {
    return { status: 'UNREACHABLE', detail: 'The host name could not be resolved. Check the URL.' }
  }
  if (s.includes('terminal prompts disabled') || s.includes('authentication failed')
      || s.includes('invalid username or password')) {
    return {
      status: 'PRIVATE',
      detail:
        'The repository asked for credentials, so it is private. Make it public before the ' +
        'deadline — evaluation runs without any account.',
    }
  }
  if (s.includes('connection refused') || s.includes('connection timed out')
      || s.includes('failed to connect') || s.includes('unable to access')) {
    return { status: 'UNREACHABLE', detail: 'The host could not be reached.' }
  }
  if (s.includes('empty repository') || s.includes('you appear to have cloned an empty')) {
    return { status: 'REJECTED', detail: 'The repository is empty — there is nothing to evaluate.' }
  }
  return null
}
