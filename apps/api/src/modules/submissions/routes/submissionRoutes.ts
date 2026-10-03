/**
 * Submission intake endpoints (E03).
 *
 * `POST /api/v1/submissions` is on the P8.1 allow-list and authenticates with a **submission
 * token** verified at this mount point — a named alternate factor, not an absence of
 * authentication. Teams have no Crucible account by design (P8.2).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { isEnabled } from '../../platform/services/configService.js'
import {
  getIntakeHealth, getSubmission, getSubmissions, getValidationHistory, revalidate,
  revalidateDue, submit,
} from '../services/submissionService.js'
import { intakeStatus, lockWindow, openWindow } from '../services/windowService.js'
import { exportCsv, intakeDashboard } from '../services/intakeReport.js'
import {
  issueSubmissionToken, listSubmissionTokens, revokeSubmissionToken, verifySubmissionToken,
  type TokenIdentity,
} from '../services/submissionTokens.js'
import { getTeams, similarTeams } from '../services/teamService.js'
import {
  bulkIssue, deliverIssued, issueForTeamsWithout, toCsv,
} from '../services/bulkTokens.js'
import { deliveryState } from '../services/tokenDelivery.js'
import { fetchArtifacts } from '../services/artifactFetch.js'
import { listArtifacts } from '../db/artifactDb.js'
import { teamView } from '../services/teamEntry.js'
import { SUBMISSION_SORTS } from '../db/submissionDb.js'
import { TOKEN_SORTS_KEYS } from '../services/submissionTokens.js'
import { BUILD_METHODS, VALIDATION_STATUSES } from '../types/submissionTypes.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })

/**
 * What a team sends.
 *
 * `teamName` is OPTIONAL and no longer identity (E17-S02 acceptance 2). The team comes from the
 * verified token; the name here is a confirmation the team may correct, and correcting it
 * renames the team rather than creating a second one.
 */
/**
 * No `teamName` (E45-S01). The token IS the team's identity, and a typed name used to rename the
 * team as a side effect of submitting — which is how one team became "test1" in testing. A team's
 * name is corrected by an organiser, on purpose, through its own route.
 */
const submitBody = z.object({
  contactEmail: z.string().email().max(320),
  challengeId: z.coerce.number().int().min(1),
  repoUrl: z.string().min(8).max(500),
  buildMethod: z.enum(BUILD_METHODS),
  dockerfilePath: z.string().min(1).max(300).optional(),
  buildCommand: z.string().min(1).max(500).optional(),
  artifactUrls: z.array(z.string().url().max(500)).max(20).default([]),
})

/** An organiser entering on a team's behalf names the team explicitly (E17-S02 acceptance 4). */
const onBehalfBody = submitBody.extend({
  teamId: z.coerce.number().int().min(1),
})

const listQuery = paginationQuerySchema.extend({
  challengeId: z.coerce.number().int().min(1).optional(),
  status: z.enum(VALIDATION_STATUSES).optional(),
  currentOnly: z.coerce.boolean().default(true),
  /**
   * Validated against the allow-list rather than passed through (E40).
   *
   * An unknown key is REFUSED, not silently defaulted: a sort that quietly does nothing looks
   * identical to a sort that worked and found this order, which is how an operator comes to
   * believe a list is ordered when it is not.
   */
  sort: z.enum(SUBMISSION_SORTS as [string, ...string[]]).optional(),
})

/**
 * A file of teams, and whether to act on it (E20).
 *
 * Capped at 256 KiB. The row limit is configuration and is checked against the parsed file, but a
 * body this size is already not a team list and should be refused before it is parsed at all.
 */
const bulkBody = z.object({
  csv: z.string().min(1).max(262_144),
  confirm: z.boolean().default(false),
})

const windowBody = z.object({
  name: z.string().min(2).max(200),
  opensAt: z.coerce.date(),
  closesAt: z.coerce.date(),
})

/**
 * Issuing a token issues an identity with it (E17-S01 acceptance 2).
 *
 * `teamId` reissues for a team that already exists. Without it a team is created from `label`,
 * and a contact is then required: it is the only way to reach a team whose repository will not
 * clone, and there is no account to fall back on.
 */
const tokenBody = z.object({
  label: z.string().min(2).max(200),
  teamId: z.coerce.number().int().min(1).optional(),
  contactEmail: z.string().email().max(320).optional(),
  expiresAt: z.coerce.date().optional(),
})

/**
 * The named alternate authentication factor for the public submission endpoints (P8.1).
 *
 * Returns WHO the bearer is, not just that the credential was good. Every team-scoped read and
 * write below takes its team id from here, so there is no request parameter through which one
 * team could name another (E17-S03 acceptance 2).
 */
async function teamIdentity(req: FastifyRequest): Promise<TokenIdentity> {
  const header = req.headers['x-submission-token']
  const presented = typeof header === 'string' ? header : ''
  if (presented === '') {
    throw new AppError(
      'UNAUTHENTICATED',
      'A submission token is required. Your organiser issued one with your team invitation.',
    )
  }
  return verifySubmissionToken(presented)
}

export async function registerSubmissionRoutes(app: FastifyInstance): Promise<void> {
  /** Public: teams need to know whether intake is open before they have a token in hand. */
  app.get('/api/v1/submissions/status', async () => ok(await intakeStatus()))

  /** Public, submission-token authenticated (P8.1 allow-list entry). */
  app.post('/api/v1/submissions', async (req, reply) => {
    if (!(await isEnabled('feature.submissions.self_service'))) {
      throw new AppError(
        'FORBIDDEN',
        'Self-service submission is closed. Contact your organiser to submit your entry.',
      )
    }
    const identity = await teamIdentity(req)
    const input = body(req, submitBody)
    const submission = await submit({
      ...input,
      teamId: identity.teamId,
      via: 'TEAM_TOKEN',
      submittedTokenId: identity.tokenId,
      actor: `token:${identity.label}`,
    })
    reply.status(201)
    return ok(submission)
  })

  /**
   * A team's own entry, scoped by their token (E17-S03).
   *
   * On the P8.1 allow-list for the same reason `POST /submissions` is: teams have no account.
   * The team id comes from the verified token and from nowhere else.
   */
  app.get('/api/v1/submissions/mine', async (req) => {
    const identity = await teamIdentity(req)
    return ok(await teamView(identity.teamId))
  })

  // ── Organiser surface ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/submissions', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, listQuery)
    const { limit, offset } = toLimitOffset(q)
    const { submissions, total } = await getSubmissions({
      ...(q.challengeId !== undefined && { challengeId: q.challengeId }),
      ...(q.status !== undefined && { status: q.status }),
      currentOnly: q.currentOnly,
    }, limit, offset, q.sort)
    return ok(submissions, pageMeta(total, q.page, q.pageSize))
  })

  app.get('/api/v1/submissions/intake-health', { preHandler: requireRole('viewer') }, async () =>
    ok(await getIntakeHealth()),
  )

  /** Intake dashboard (E03-S05): real counts, and every failure with its reason and contact. */
  app.get('/api/v1/submissions/dashboard', { preHandler: requireRole('viewer') }, async () =>
    ok(await intakeDashboard()),
  )

  app.get('/api/v1/submissions/export.csv', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const q = query(req, z.object({ challengeId: z.coerce.number().int().min(1).optional() }))
    const csv = await exportCsv(q.challengeId)
    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="crucible-submissions.csv"')
    return csv
  })

  app.get('/api/v1/submissions/:id', { preHandler: requireRole('viewer') }, async (req) =>
    ok(await getSubmission(params(req, idParams).id)),
  )

  app.get('/api/v1/submissions/:id/validation-history',
    { preHandler: requireRole('viewer') }, async (req) =>
      ok(await getValidationHistory(params(req, idParams).id)),
  )

  app.post('/api/v1/submissions/:id/revalidate',
    { preHandler: requireRole('organiser') }, async (req) =>
      ok(await revalidate(params(req, idParams).id)),
  )

  app.post('/api/v1/submissions/revalidate-due',
    { preHandler: requireRole('organiser') }, async () => ok(await revalidateDue()),
  )

  /**
   * An organiser may enter a submission on a team's behalf — a support path for the day.
   *
   * The team is named explicitly and the record says it was entered for them, by whom. An
   * organiser standing in for a team is a legitimate thing to do and an illegitimate thing to
   * leave indistinguishable from the team doing it themselves.
   */
  app.post('/api/v1/submissions/on-behalf', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, onBehalfBody)
    const submission = await submit({
      ...input, via: 'ORGANISER', submittedTokenId: null, actor: principalOf(req).email,
    })
    reply.status(201)
    return ok(submission)
  })

  // ── Teams (E17-S01) ─────────────────────────────────────────────────────────────────────
  app.get('/api/v1/submissions/teams', { preHandler: requireRole('organiser') }, async () =>
    ok(await getTeams()),
  )

  /**
   * Teams whose names differ from this one only in punctuation, case or a leading "the".
   *
   * Advisory. It exists so an organiser about to issue a token for "The Night Shift" can see
   * that "Night Shift" already has one — the collision that, until now, neither the organiser
   * nor either team could see.
   */
  app.get('/api/v1/submissions/teams/similar', { preHandler: requireRole('organiser') }, async (req) => {
    const q = query(req, z.object({ name: z.string().min(1).max(200) }))
    return ok(await similarTeams(q.name))
  })

  // ── Window ──────────────────────────────────────────────────────────────────────────────
  app.post('/api/v1/submissions/window', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, windowBody)
    const window = await openWindow({ ...input, actor: principalOf(req).email })
    reply.status(201)
    return ok(window)
  })

  app.post('/api/v1/submissions/window/lock', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await lockWindow(principalOf(req).email)),
  )

  // ── Tokens (P8.2) ───────────────────────────────────────────────────────────────────────
  app.get('/api/v1/submissions/tokens', { preHandler: requireRole('organiser') }, async (req) => {
    const q = query(req, z.object({
      // Allow-listed: an unknown key is refused, not silently defaulted (E40).
      sort: z.enum(TOKEN_SORTS_KEYS as [string, ...string[]]).optional(),
    }))
    return ok(await listSubmissionTokens(q.sort))
  })

  app.post('/api/v1/submissions/tokens', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, tokenBody)
    const issued = await issueSubmissionToken({
      label: input.label,
      ...(input.teamId !== undefined && { teamId: input.teamId }),
      ...(input.contactEmail !== undefined && { contactEmail: input.contactEmail }),
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      issuedBy: principalOf(req).email,
    })
    reply.status(201)
    return ok(issued)
  })

  /**
   * Register a cohort from one file (E20).
   *
   * `confirm: false` returns the plan and writes nothing, so an operator sees which rows are new,
   * which match a team that already exists, and which cannot be acted on — BEFORE fifty teams
   * exist. `confirm: true` issues, all or nothing.
   *
   * The response carries every plaintext token. It is the only moment they exist, so the client
   * must hand the operator a file before anything else can go wrong.
   */
  app.post('/api/v1/submissions/tokens/bulk', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, bulkBody)
    return ok(await bulkIssue({ ...input, actor: principalOf(req).email }))
  })

  /**
   * Issue for every team that has none (E29-S01).
   *
   * No file on the way in: once the roster has built the teams there is nothing to assemble, and
   * exporting forty names in order to re-import them would be work the tool invented.
   */
  /**
   * Issue for every team that has none, and optionally deliver in the same act (E34).
   *
   * `deliver` cannot be a separate later call: the plaintext exists only inside this response
   * (P8.3), so a delivery job run afterwards would have nothing to send.
   */
  app.post('/api/v1/submissions/tokens/for-teams', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, z.object({
      confirm: z.boolean().default(false),
      deliver: z.boolean().default(false),
    }))
    const actor = principalOf(req).email
    const plan = await issueForTeamsWithout({ confirm: input.confirm, actor })
    if (!input.deliver || !plan.issued) return ok(plan)
    return ok({ ...plan, delivery: await deliverIssued(plan.rows, actor) })
  })

  /**
   * Read the supporting documents a team attached (E36).
   *
   * Explicitly triggered, never automatic on submit. Fetching entrant-supplied URLs is the one
   * outbound request this system makes on a team's instruction, and an organiser should be the
   * one who decides it happens.
   */
  app.post('/api/v1/submissions/:id/artifacts', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await fetchArtifacts({
      submissionId: params(req, idParams).id, actor: principalOf(req).email,
    })),
  )

  /** What was read. Reviewer and above: this is evidence a placement may rest on. */
  app.get('/api/v1/submissions/:id/artifacts', { preHandler: requireRole('reviewer') }, async (req) =>
    ok(await listArtifacts(params(req, idParams).id)),
  )

  /** Whether each team was sent what it needs to submit. Organiser-only: it names addresses. */
  app.get('/api/v1/submissions/tokens/delivery', { preHandler: requireRole('organiser') }, async () =>
    ok(await deliveryState()),
  )

  /** The same plan rendered as the file an organiser sends out from. */
  app.post('/api/v1/submissions/tokens/bulk/export.csv',
    { preHandler: requireRole('organiser') }, async (req, reply) => {
      const input = body(req, bulkBody)
      const plan = await bulkIssue({ ...input, actor: principalOf(req).email })
      reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="crucible-team-tokens.csv"')
      return toCsv(plan)
    })

  app.delete('/api/v1/submissions/tokens/:id', { preHandler: requireRole('organiser') }, async (req, reply) => {
    await revokeSubmissionToken(params(req, idParams).id, principalOf(req).email)
    reply.status(204)
    return null
  })
}
