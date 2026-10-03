/**
 * Challenge intake endpoints (E02-S01, E02-S02).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { getNumber } from '../../platform/services/configService.js'
import {
  createChallenge, deleteChallenge, downloadArtifact, getArtifacts, getChallenge,
  getChallenges, getExtractionHealth, setChallengeStatus, uploadArtifact,
} from '../services/challengeService.js'
import { listOpenChallenges } from '../db/challengeDb.js'
import { extractChallenge, extractOne } from '../services/extractionService.js'
import { briefSections, resolveSourceRef } from '../services/briefLookup.js'
import { supportedFormats } from '../services/extractors/extractorRegistry.js'
import { ARTIFACT_KINDS, CHALLENGE_STATUSES } from '../types/challengeTypes.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })
const artifactParams = z.object({
  id: z.coerce.number().int().min(1),
  artifactId: z.coerce.number().int().min(1),
})

const sourceRefQuery = z.object({ sourceRef: z.string().min(1).max(500) })

const createBody = z.object({
  name: z.string().min(3).max(200),
  description: z.string().max(4000).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/).optional(),
})

const statusBody = z.object({ status: z.enum(CHALLENGE_STATUSES) })
const deleteBody = z.object({ reason: z.string().min(3).max(500).optional() })

export async function registerChallengeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/challenges', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, paginationQuerySchema)
    const { limit, offset } = toLimitOffset(q)
    const { challenges, total } = await getChallenges(limit, offset)
    return ok(challenges, pageMeta(total, q.page, q.pageSize))
  })

  /**
   * Public: a team filling in the submission form has no account and must still be able to say
   * which challenge they are entering. Names of OPEN challenges only — nothing a draft
   * challenge would leak (P8.1 allow-list entry).
   */
  app.get('/api/v1/challenges/open', async () => ok(await listOpenChallenges()))

  app.get('/api/v1/challenges/formats', { preHandler: requireRole('viewer') }, async () =>
    ok(supportedFormats()),
  )

  app.post('/api/v1/challenges', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, createBody)
    const challenge = await createChallenge({ ...input, actor: principalOf(req).email })
    reply.status(201)
    return ok(challenge)
  })

  app.get('/api/v1/challenges/:id', { preHandler: requireRole('viewer') }, async (req) =>
    ok(await getChallenge(params(req, idParams).id)),
  )

  app.patch('/api/v1/challenges/:id/status', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const { status } = body(req, statusBody)
    return ok(await setChallengeStatus(id, status, principalOf(req).email))
  })

  app.delete('/api/v1/challenges/:id', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, idParams)
    const input = req.body ? body(req, deleteBody) : {}
    await deleteChallenge(id, principalOf(req).email, input.reason ?? 'ADMIN_ACTION')
    reply.status(204)
    return null
  })

  // ── Artifacts ──────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/challenges/:id/artifacts', { preHandler: requireRole('viewer') }, async (req) =>
    ok(await getArtifacts(params(req, idParams).id)),
  )

  app.post('/api/v1/challenges/:id/artifacts', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, idParams)
    const upload = await readUpload(req)
    const artifact = await uploadArtifact({
      challengeId: id,
      kind: upload.kind,
      filename: upload.filename,
      mediaType: upload.mediaType,
      content: upload.content,
      actor: principalOf(req).email,
    })
    reply.status(201)
    return ok(artifact)
  })

  app.get('/api/v1/challenges/:id/artifacts/:artifactId/content',
    { preHandler: requireRole('viewer') }, async (req, reply) => {
      const { artifactId } = params(req, artifactParams)
      const { artifact, content } = await downloadArtifact(artifactId)
      await recordAudit({
        actor: principalOf(req).email, action: 'challenge.artifact_downloaded',
        subjectType: 'challenge_artifact', subjectId: String(artifactId),
        payload: { filename: artifact.filename },
      })
      reply
        .type(artifact.mediaType)
        .header('content-disposition', `attachment; filename="${encodeURIComponent(artifact.filename)}"`)
        .send(content)
      return reply
    })

  app.post('/api/v1/challenges/:id/extract', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    await getChallenge(id)
    return ok(await extractChallenge(id, principalOf(req).email))
  })

  app.post('/api/v1/challenges/:id/artifacts/:artifactId/extract',
    { preHandler: requireRole('organiser') }, async (req) => {
      const { artifactId } = params(req, artifactParams)
      const outcome = await extractOne(artifactId)
      if (!outcome) throw new AppError('NOT_FOUND', `Artifact ${artifactId} was not found.`)
      return ok(outcome)
    })

  /** The extracted brief, section by section — what a `source_ref` points at (E02-S06 #3). */
  app.get('/api/v1/challenges/:id/brief', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    await getChallenge(id)
    return ok(await briefSections(id))
  })

  app.get('/api/v1/challenges/:id/brief/passage', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const { sourceRef } = query(req, sourceRefQuery)
    await getChallenge(id)
    return ok(await resolveSourceRef(id, sourceRef))
  })

  app.get('/api/v1/challenges/:id/extraction-health',
    { preHandler: requireRole('viewer') }, async (req) =>
      ok(await getExtractionHealth(params(req, idParams).id)),
  )
}

const kindSchema = z.enum(ARTIFACT_KINDS)

function describeBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(0)} MB`
}

interface Upload {
  kind: (typeof ARTIFACT_KINDS)[number]
  filename: string
  mediaType: string
  content: Buffer
}

/**
 * Read one file from a multipart request.
 *
 * The size cap is enforced here as well as in the service: Fastify aborts an oversized stream
 * before the service ever sees it, which is the only way to avoid buffering a hostile upload
 * into memory first.
 */
async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Upload the brief as multipart/form-data with a "file" part.',
    )
  }
  const maxBytes = await getNumber('platform.max_upload_bytes')
  const file = await req.file({
    limits: { fileSize: maxBytes, files: 1 },
    throwFileSizeLimit: false,
  })
  if (!file) throw new AppError('VALIDATION_FAILED', 'No file part was present in the upload.')

  const content = await file.toBuffer()
  if (file.file.truncated) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `'${file.filename}' exceeds the per-file limit of ${describeBytes(maxBytes)}.`,
    )
  }

  const rawKind = (file.fields as Record<string, { value?: unknown } | undefined>)['kind']?.value
  const parsedKind = kindSchema.safeParse(typeof rawKind === 'string' ? rawKind : 'BRIEF')
  if (!parsedKind.success) {
    throw new AppError('VALIDATION_FAILED', `kind must be one of: ${ARTIFACT_KINDS.join(', ')}.`)
  }

  return {
    kind: parsedKind.data,
    filename: file.filename,
    mediaType: file.mimetype,
    content,
  }
}
