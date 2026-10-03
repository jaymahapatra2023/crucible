/**
 * Submission intake (E03-S01, E03-S02, E03-S03).
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { preflight } from '../../../lib/ports/preflightPort.js'
import { tx } from '../../../db/pool.js'
import { getNumber } from '../../platform/services/configService.js'
import { frozenRubric } from '../../rubrics/services/rubricService.js'
import { getChallenge } from '../../challenges/services/challengeService.js'
import {
  countSubmissions, insertSubmission, listSubmissions, recordValidation, selectCurrentFor,
  selectPreflightFor,
  selectForRevalidation, selectIntakeHealth, selectSubmission, selectValidationHistory,
  standDown, linkSupersededBy, type SubmissionFilter,
} from '../db/submissionDb.js'
import { reviseTeam } from './teamService.js'
import { validateRepository, isSafeRepoPath } from './repoValidation.js'
import { assertIntakeOpen } from './windowService.js'
import type { BuildMethod, Submission, SubmissionRoute } from '../types/submissionTypes.js'

const log = createLogger('submissions', 'submissionService')

export interface SubmitInput {
  /** Identity, from the verified token or chosen explicitly by an organiser (E17-S02). */
  teamId: number
  /**
   * The name the team confirms or corrects on the form.
   *
   * It no longer decides who they are — it renames the team when it differs. Omitted, the team
   * keeps the name it has.
   */
  contactEmail: string
  challengeId: number
  repoUrl: string
  buildMethod: BuildMethod
  dockerfilePath?: string
  buildCommand?: string
  artifactUrls?: string[]
  /** How the entry arrived. Recorded, so a disputed entry can be traced to its credential. */
  via: SubmissionRoute
  submittedTokenId?: number | null
  actor: string | null
}

/**
 * Accept a submission.
 *
 * Validation runs inline and synchronously. A team that is told at submit time that their
 * repository is private can fix it; a team told on evaluation night cannot. That is the entire
 * value of E03-S02 and it is worth the wait of one clone.
 */
export async function submit(input: SubmitInput): Promise<Submission> {
  await assertIntakeOpen()

  const challenge = await getChallenge(input.challengeId)

  // The rubric must be published before submissions are accepted — P0's governance commitment
  // is that teams know the standard in advance, and accepting entries first would break it.
  const rubric = await frozenRubric(input.challengeId)
  if (!rubric || !rubric.publishedAt) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `No published rubric exists for '${challenge.name}'. Submissions cannot be accepted ` +
        `before teams can read the standard they will be judged by.`,
    )
  }

  assertBuildDeclaration(input)

  const maxArtifacts = await getNumber('submissions.max_artifact_urls')
  const artifactUrls = input.artifactUrls ?? []
  if (artifactUrls.length > maxArtifacts) {
    throw new AppError(
      'VALIDATION_FAILED',
      `At most ${maxArtifacts} supporting links may be attached; ${artifactUrls.length} were given.`,
    )
  }

  // Identity first, then the display name. A team correcting its spelling on the form is a
  // rename of the team it already is — which is the whole point of keying on the id.
  // The contact may be corrected by a submission — that is the team saying how to reach them.
  // The NAME may not (E45-S01): identity is the token, and a rename is an organiser's act.
  const team = await reviseTeam({
    teamId: input.teamId,
    contactEmail: input.contactEmail,
    actor: input.actor ?? 'team',
  })

  const previous = await selectCurrentFor(team.teamId, input.challengeId)
  const version = (previous?.version ?? 0) + 1

  const submission = await tx(async (client) => {
    // Stand the previous entry down first: the partial unique index permits one CURRENT row per
    // team and challenge, so the insert would otherwise collide with the entry it replaces.
    if (previous) await standDown(previous.submissionId, client)

    const created = await insertSubmission({
      teamId: team.teamId,
      // The name as it stood at this version. A later rename does not rewrite it: this is what
      // the team actually entered under, and the appeal packet cites it.
      teamName: team.displayName,
      contactEmail: input.contactEmail.trim(),
      challengeId: input.challengeId,
      repoUrl: input.repoUrl.trim(),
      buildMethod: input.buildMethod,
      dockerfilePath: input.dockerfilePath?.trim() ?? null,
      buildCommand: input.buildCommand?.trim() ?? null,
      artifactUrls,
      version,
      submittedBy: input.actor,
      submittedVia: input.via,
      submittedTokenId: input.submittedTokenId ?? null,
    }, client)

    // Resubmission supersedes rather than overwrites (E03-S01 acceptance 3).
    if (previous) await linkSupersededBy(previous.submissionId, created.submissionId, client)
    return created
  })

  await recordAudit({
    actor: input.actor ?? team.displayName,
    action: 'submissions.submission_created',
    subjectType: 'submission',
    subjectId: String(submission.submissionId),
    payload: {
      teamId: team.teamId, teamName: submission.teamName, challengeId: submission.challengeId,
      version, supersedes: previous?.submissionId ?? null,
      // The question a disputed entry turns on: was this the team's own token, or an organiser
      // acting for them? (E17-S02 acceptance 4.)
      via: input.via, tokenId: input.submittedTokenId ?? null,
    },
  })

  return revalidate(submission.submissionId)
}

/** A team declares how the project builds, so the prober need not guess (E03-S03). */
function assertBuildDeclaration(input: SubmitInput): void {
  if (input.buildMethod === 'DOCKERFILE') {
    const path = input.dockerfilePath?.trim() ?? ''
    if (path === '') {
      throw new AppError(
        'VALIDATION_FAILED',
        'Declaring DOCKERFILE requires the path to the Dockerfile, relative to the repository root.',
      )
    }
    if (!isSafeRepoPath(path)) {
      throw new AppError('VALIDATION_FAILED', `'${path}' is not a valid path inside the repository.`)
    }
    return
  }
  const command = input.buildCommand?.trim() ?? ''
  if (command === '') {
    throw new AppError(
      'VALIDATION_FAILED',
      'Declaring COMMAND requires a single build command, for example "npm ci && npm run build".',
    )
  }
  if (command.length > 500) {
    throw new AppError('VALIDATION_FAILED', 'The build command must be a single command under 500 characters.')
  }
}

/** Validate (or re-validate) one submission and record the outcome plus its history. */
export async function revalidate(submissionId: number): Promise<Submission> {
  const submission = await selectSubmission(submissionId)
  if (!submission) throw new AppError('NOT_FOUND', `Submission ${submissionId} was not found.`)

  const outcome = await validateRepository({
    repoUrl: submission.repoUrl,
    buildMethod: submission.buildMethod,
    dockerfilePath: submission.dockerfilePath,
  })

  const previousStatus = submission.validationStatus
  const updated = await recordValidation({
    submissionId,
    status: outcome.status,
    detail: outcome.detail,
    commitSha: outcome.commitSha ?? null,
    durationMs: outcome.durationMs,
    ...(outcome.normalisedUrl !== undefined && { normalisedUrl: outcome.normalisedUrl }),
  })
  if (!updated) throw new AppError('NOT_FOUND', `Submission ${submissionId} disappeared mid-validation.`)

  // Every change of validation outcome, not only regressions (E09-S01 acceptance 1). Whether a
  // submission validated decides whether it is scored at all, and a re-check that silently
  // turned PENDING into PRIVATE is exactly the sort of thing a team disputes later.
  if (previousStatus !== outcome.status) {
    await recordAudit({
      actor: 'system', action: 'submissions.validated', subjectType: 'submission',
      subjectId: String(submissionId),
      payload: {
        from: previousStatus, to: outcome.status, detail: outcome.detail,
        commitSha: outcome.commitSha ?? null,
      },
    })
  }

  // Passing tier 1 queues tier 2 (E46-S02 acceptance 1) — on the transition only, so an hourly
  // re-check that finds an entry still VALID does not build it again every hour. Advisory work
  // that blocks nothing must not be able to fail the submission it describes.
  if (outcome.status === 'VALID' && previousStatus !== 'VALID') {
    try {
      await preflight().enqueue({ submissionId, triggeredBy: 'submission' })
    } catch (err) {
      log.error('submission validated but could not be queued for pre-flight', { submissionId, err })
    }
  }

  // Risk R8: a repository that was valid and is no longer is the case this exists to catch.
  if (previousStatus === 'VALID' && outcome.status !== 'VALID') {
    log.warn('submission stopped validating', {
      submissionId, teamName: submission.teamName, from: previousStatus, to: outcome.status,
    })
    await recordAudit({
      actor: 'system', action: 'submissions.validation_regressed', subjectType: 'submission',
      subjectId: String(submissionId),
      payload: { from: previousStatus, to: outcome.status, detail: outcome.detail },
    })
  }

  return updated
}

/** Re-check submissions on a schedule until the window closes (E03-S02 acceptance 4). */
export async function revalidateDue(limit = 50): Promise<{ checked: number; regressed: number }> {
  const interval = await getNumber('submissions.revalidate_interval_minutes')
  const due = await selectForRevalidation(interval, limit)

  let regressed = 0
  for (const submission of due) {
    const before = submission.validationStatus
    const after = await revalidate(submission.submissionId)
    if (before === 'VALID' && after.validationStatus !== 'VALID') regressed++
  }
  return { checked: due.length, regressed }
}

export async function getSubmission(submissionId: number): Promise<Submission> {
  const submission = await selectSubmission(submissionId)
  if (!submission) throw new AppError('NOT_FOUND', `Submission ${submissionId} was not found.`)
  return submission
}

export async function getSubmissions(
  filter: SubmissionFilter, limit: number, offset: number, sort?: string,
) {
  const [rows, total] = await Promise.all([
    listSubmissions(filter, limit, offset, sort),
    // Counted under the same filter and independently of the page, so the total is the roster's
    // and not the page's (P5.7).
    countSubmissions(filter),
  ])
  // What tier 2 concluded, beside each entry (E46-S02 acceptance 4). Null when never queued.
  const preflights = await selectPreflightFor(rows.map((s) => s.submissionId))
  const submissions = rows.map((s) => ({ ...s, preflight: preflights.get(s.submissionId) ?? null }))
  return { submissions, total }
}

export const getValidationHistory = selectValidationHistory
export const getIntakeHealth = selectIntakeHealth
