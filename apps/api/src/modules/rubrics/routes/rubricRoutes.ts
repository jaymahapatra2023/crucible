/**
 * Rubric lifecycle endpoints (E02-S04, E02-S07, E02-S08).
 *
 * Criterion editing lives in `criterionRoutes.ts` — splitting by resource keeps both files
 * within the P1.4 route limit and keeps "what can be done to a rubric" readable in one screen.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { DIMENSIONS, type Criterion } from '@crucible/rubric'
import { body, params } from '../../../http/validate.js'
import { AppError } from '../../../lib/appError.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { getChallenge } from '../../challenges/services/challengeService.js'
import {
  approvalReadiness, approveRubric, createVersion, freezeRubric, frozenRubric,
  listRubrics, loadRubric, setDimensionWeights,
} from '../services/rubricService.js'
import { synthesiseRubric, nextVersionFor } from '../services/rubricSynthesis.js'
import {
  publishRubric, publishedDocument, publishedRubricBySlug, toHtml, toMarkdown,
} from '../services/rubricExport.js'
import { selectPublicationHistory } from '../db/publicationDb.js'
import type { CriterionInput } from '../db/rubricDb.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })

/**
 * Creating a version.
 *
 * `copyFrom` carries an existing version's criteria and dimension weights into the new draft.
 * A committee told "this rubric is frozen, create a new version to change it" almost never
 * wants to start from nothing — they want to adjust one weight or reword one anchor. An empty
 * draft makes them retype the whole rubric, which is how a "correction" turns into a rewrite.
 */
const createVersionBody = z.object({
  copyFrom: z.coerce.number().int().min(1).optional(),
})
const slugParams = z.object({ slug: z.string().min(2).max(64) })

const dimensionWeightsBody = z.object({
  weights: z.object(Object.fromEntries(
    DIMENSIONS.map((d) => [d, z.number().min(0).max(1)]),
  ) as Record<(typeof DIMENSIONS)[number], z.ZodNumber>),
})

const approveBody = z.object({
  acknowledgedWarnings: z.array(z.string()).default([]),
})

export async function registerRubricRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/challenges/:id/rubrics', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    await getChallenge(id)
    return ok(await listRubrics(id))
  })

  app.get('/api/v1/challenges/:id/rubrics/frozen', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    return ok(await frozenRubric(id))
  })

  /** Generate a new DRAFT version from the extracted brief (E02-S04). */
  app.post('/api/v1/challenges/:id/rubrics/generate',
    { preHandler: requireRole('organiser') }, async (req, reply) => {
      const { id } = params(req, idParams)
      const challenge = await getChallenge(id)
      const result = await synthesiseRubric({
        challengeId: id,
        challengeName: challenge.name,
        actor: principalOf(req).email,
      })
      reply.status(201)
      return ok(result)
    })

  app.get('/api/v1/challenges/:id/rubrics/next-version',
    { preHandler: requireRole('organiser') }, async (req) => {
      const { id } = params(req, idParams)
      return ok({ nextVersion: await nextVersionFor(id) })
    })

  /** Create a DRAFT version — empty, or carrying an existing version's content forward. */
  app.post('/api/v1/challenges/:id/rubrics',
    { preHandler: requireRole('organiser') }, async (req, reply) => {
      const { id } = params(req, idParams)
      await getChallenge(id)
      const input = req.body ? body(req, createVersionBody) : {}

      const source = input.copyFrom === undefined ? null : await loadRubric(input.copyFrom)
      if (source && source.challengeId !== String(id)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Rubric ${input.copyFrom} belongs to a different challenge. A version can only be ` +
            `copied from another version of the same challenge.`,
        )
      }

      const rubric = await createVersion({
        challengeId: id,
        criteria: source ? source.criteria.map(asCriterionInput) : [],
        ...(source && { dimensionWeights: source.dimensionWeights }),
        actor: principalOf(req).email,
        ...(source && { supersedes: Number(source.rubricId) }),
      })
      reply.status(201)
      return ok(rubric)
    })

  app.get('/api/v1/rubrics/:id', { preHandler: requireRole('viewer') }, async (req) =>
    ok(await loadRubric(params(req, idParams).id)),
  )

  /** Validation report — what blocks approval, and which warnings need acknowledging. */
  app.get('/api/v1/rubrics/:id/readiness', { preHandler: requireRole('viewer') }, async (req) =>
    ok(await approvalReadiness(params(req, idParams).id)),
  )

  app.put('/api/v1/rubrics/:id/dimension-weights',
    { preHandler: requireRole('organiser') }, async (req) => {
      const { id } = params(req, idParams)
      const { weights } = body(req, dimensionWeightsBody)
      return ok(await setDimensionWeights(id, weights, principalOf(req).email))
    })

  app.post('/api/v1/rubrics/:id/approve', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const input = req.body ? body(req, approveBody) : { acknowledgedWarnings: [] }
    return ok(await approveRubric(id, principalOf(req).email, input.acknowledgedWarnings))
  })

  app.post('/api/v1/rubrics/:id/freeze', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await freezeRubric(params(req, idParams).id, principalOf(req).email)),
  )

  app.post('/api/v1/rubrics/:id/publish', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await publishRubric(params(req, idParams).id, principalOf(req).email)),
  )

  // ── Export (E02-S08) ────────────────────────────────────────────────────────────────────
  app.get('/api/v1/rubrics/:id/export.md', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = params(req, idParams)
    const rubric = await loadRubric(id)
    const challenge = await getChallenge(Number(rubric.challengeId))
    reply.type('text/markdown; charset=utf-8')
    return toMarkdown(rubric, challenge.name)
  })

  app.get('/api/v1/rubrics/:id/export.html', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = params(req, idParams)
    const rubric = await loadRubric(id)
    const challenge = await getChallenge(Number(rubric.challengeId))
    reply.type('text/html; charset=utf-8')
    return toHtml(rubric, challenge.name)
  })

  /**
   * Every publication of a rubric, with its document hash (E09-S04 acceptance 1).
   *
   * The proof of what was published and when. Append-only in the database, so this listing is
   * the whole history rather than the surviving version of it.
   */
  app.get('/api/v1/rubrics/:id/publications', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const history = await selectPublicationHistory(id)
    return ok(history.map((p) => ({
      publicationId: p.publication_id,
      version: p.version,
      contentHash: p.content_hash,
      documentHash: p.document_hash,
      publishedBy: p.published_by,
      publishedAt: p.published_at,
    })))
  })

  /**
   * The published rubric, readable without an account.
   *
   * On the P8.1 allow-list by design: teams have no Crucible account, and P0's governance
   * commitment requires them to be able to read the standard before submissions open.
   *
   * Serves the STORED document rather than re-rendering it (E09-S04 acceptance 2), so what a
   * team reads today is byte-for-byte what was published.
   */
  app.get('/api/v1/rubrics/published/:slug', async (req, reply) => {
    const { slug } = params(req, slugParams)
    const publication = await publishedDocument(slug)

    const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
    if (wantsHtml) {
      reply.type('text/html; charset=utf-8')
      // The hash travels with the document, so a copy can be proved unaltered.
      reply.header('x-document-hash', publication.document_hash)
      return publication.document_html
    }

    // The rubric's own fields stay at the top level. Teams and their tooling read this
    // endpoint, and moving them under a wrapper to make room for the publication metadata
    // would break every existing reader for the sake of tidiness.
    const rubric = await publishedRubricBySlug(slug)
    return ok({
      ...rubric,
      publication: {
        publicationId: publication.publication_id,
        publishedAt: publication.published_at,
        documentHash: publication.document_hash,
        contentHash: publication.content_hash,
      },
    })
  })

  /** The published document as Markdown, exactly as it was stored. */
  app.get('/api/v1/rubrics/published/:slug/export.md', async (req, reply) => {
    const { slug } = params(req, slugParams)
    const publication = await publishedDocument(slug)
    reply.type('text/markdown; charset=utf-8')
    reply.header('x-document-hash', publication.document_hash)
    return publication.document_markdown
  })
}

/**
 * A stored criterion as the input that would recreate it.
 *
 * The gate's verdict is deliberately NOT carried over. `needsRewrite` says the gate could not
 * confirm THIS wording was scoreable; the new version's wording has not been gated yet, and
 * inheriting a flag would either excuse a fresh problem or condemn a fixed one.
 */
function asCriterionInput(c: Criterion): CriterionInput {
  return {
    dimension: c.dimension,
    name: c.name,
    description: c.description,
    weight: c.weight,
    evidenceSpec: c.evidenceSpec,
    anchors: c.anchors,
    sourceRef: c.sourceRef ?? null,
    sortOrder: c.sortOrder,
  }
}
