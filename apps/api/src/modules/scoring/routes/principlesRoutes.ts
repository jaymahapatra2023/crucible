/**
 * Principles and standards administration (E06-S03 acceptance 4, OD-2).
 *
 * The nine pillars ship INACTIVE. Adopting a list is a deliberate act by an organiser, recorded
 * in the audit log — not a default that nobody chose but everybody is judged by.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import {
  listPrinciples, listStandards, setPrincipleActive, setStandardActive,
  PILLARS, STANDARD_CATEGORIES,
} from '../db/principlesDb.js'
import {
  createPrinciple, createStandard, editPrinciple, editStandard,
  retirePrinciple, retireStandard,
} from '../services/catalogueService.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })
const activeBody = z.object({ active: z.boolean() })

const anchorsSchema = z.tuple([
  z.string().trim().min(3).max(500), z.string().trim().min(3).max(500),
  z.string().trim().min(3).max(500), z.string().trim().min(3).max(500),
  z.string().trim().min(3).max(500),
])

const principleBody = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,39}$/,
    'A code is upper-case letters, digits and underscores, e.g. SEC_INPUT.'),
  pillar: z.enum(PILLARS),
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(2000),
  rationale: z.string().trim().max(2000).default(''),
  guidance: z.string().trim().max(4000).default(''),
  // The bar E02-S05 applies to rubric criteria applies here: a principle nobody can point at
  // in a repository cannot be scored against one.
  evidenceSpec: z.string().trim().min(20).max(1000),
  anchors: anchorsSchema,
  sourceRefs: z.array(z.string().trim().max(300)).max(20).default([]),
  tags: z.array(z.string().trim().max(60)).max(20).default([]),
  owner: z.string().trim().max(200).nullable().default(null),
  sortOrder: z.number().int().min(0).max(9999).default(100),
})

const standardBody = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,39}$/,
    'A code is upper-case letters, digits and underscores, e.g. STD_NO_SECRETS.'),
  category: z.enum(STANDARD_CATEGORIES),
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(2000),
  rationale: z.string().trim().max(2000).default(''),
  evidenceSpec: z.string().trim().min(20).max(1000),
  mandatory: z.boolean().default(true),
  appliesTo: z.array(z.string().trim().max(60)).max(20).default(['ALL']),
  tags: z.array(z.string().trim().max(60)).max(20).default([]),
  sourceDocument: z.string().trim().max(300).nullable().default(null),
  owner: z.string().trim().max(200).nullable().default(null),
  effectiveDate: z.string().trim().date().nullable().default(null),
  reviewDate: z.string().trim().date().nullable().default(null),
  sortOrder: z.number().int().min(0).max(9999).default(100),
})

export async function registerPrinciplesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Both lists, adopted and not.
   *
   * Returns everything rather than only the active rows, and says how many are adopted: a
   * committee looking at this screen needs to see what it has NOT chosen as much as what it has.
   */
  app.get('/api/v1/principles', { preHandler: requireRole('viewer') }, async () => {
    const [principles, standards] = await Promise.all([listPrinciples(), listStandards()])
    return ok({
      principles,
      standards,
      adoptedPrinciples: principles.filter((p) => p.active).length,
      adoptedStandards: standards.filter((s) => s.active).length,
      // Said plainly, because an unadopted list produces an unscored dimension rather than an
      // error, and an organiser who has not noticed would see only a partial composite.
      note: principles.some((p) => p.active) || standards.some((s) => s.active)
        ? null
        : 'No principle or standard has been adopted. Until one is, the principles-and-standards '
          + 'dimension is not scored at all and every composite will be marked partial.',
    })
  })

  /** The vocabularies an author chooses from, so a form need not hard-code them. */
  app.get('/api/v1/principles/vocabularies', { preHandler: requireRole('viewer') }, async () =>
    ok({ pillars: PILLARS, standardCategories: STANDARD_CATEGORIES }),
  )

  /**
   * Author a principle.
   *
   * Created INACTIVE whoever creates it: writing a principle down is not the same act as
   * putting it into the evaluation, and adopting it is separately audited (OD-2).
   */
  app.post('/api/v1/principles', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, principleBody)
    reply.status(201)
    return ok(await createPrinciple({
      ...input, anchors: input.anchors as [string, string, string, string, string],
    }, principalOf(req).email))
  })

  app.put('/api/v1/principles/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const input = body(req, principleBody)
    return ok(await editPrinciple(id, {
      ...input, anchors: input.anchors as [string, string, string, string, string],
    }, principalOf(req).email))
  })

  /** Remove it, or retire it when it has already been assessed against. */
  app.delete('/api/v1/principles/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    return ok(await retirePrinciple(id, principalOf(req).email))
  })

  app.post('/api/v1/standards', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, standardBody)
    reply.status(201)
    return ok(await createStandard(input, principalOf(req).email))
  })

  app.put('/api/v1/standards/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    return ok(await editStandard(id, body(req, standardBody), principalOf(req).email))
  })

  app.delete('/api/v1/standards/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    return ok(await retireStandard(id, principalOf(req).email))
  })

  app.patch('/api/v1/principles/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const { active } = body(req, activeBody)
    const row = await setPrincipleActive(id, active)
    if (!row) throw new AppError('NOT_FOUND', `Principle ${id} was not found.`)

    await recordAudit({
      actor: principalOf(req).email,
      action: active ? 'scoring.principle_adopted' : 'scoring.principle_withdrawn',
      subjectType: 'arch_principle',
      subjectId: String(id),
      payload: { code: row.code, name: row.name },
    })
    return ok(row)
  })

  app.patch('/api/v1/standards/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const { active } = body(req, activeBody)
    const row = await setStandardActive(id, active)
    if (!row) throw new AppError('NOT_FOUND', `Standard ${id} was not found.`)

    await recordAudit({
      actor: principalOf(req).email,
      action: active ? 'scoring.standard_adopted' : 'scoring.standard_withdrawn',
      subjectType: 'it_standard',
      subjectId: String(id),
      payload: { code: row.code, name: row.name },
    })
    return ok(row)
  })
}
