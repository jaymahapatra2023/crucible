/**
 * Challenge lifecycle (E02-S01).
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { getNumber } from '../../platform/services/configService.js'
import {
  countChallenges, insertArtifact, insertChallenge, listChallenges, selectArtifact, selectArtifacts,
  selectChallenge, selectChallengeBySlug, selectExtractionHealth, softDeleteChallenge,
  updateChallengeStatus,
} from '../db/challengeDb.js'
import { hashContent, readArtifact, storeArtifact } from './artifactStorage.js'
import { extractArtifact } from './extractionService.js'
import { isSupported, supportedFormats } from './extractors/extractorRegistry.js'
import type {
  ArtifactKind, Challenge, ChallengeArtifact, ChallengeStatus,
} from '../types/challengeTypes.js'

const log = createLogger('challenges', 'challengeService')

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

export async function createChallenge(input: {
  name: string
  description?: string
  slug?: string
  actor: string
}): Promise<Challenge> {
  const slug = input.slug?.trim() || slugify(input.name)
  if (slug.length < 3) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Could not derive a usable slug from '${input.name}'. Supply one explicitly.`,
    )
  }
  if (await selectChallengeBySlug(slug)) {
    throw new AppError('ALREADY_EXISTS', `A challenge with slug '${slug}' already exists.`)
  }

  const challenge = await insertChallenge({
    name: input.name, slug, description: input.description ?? '', createdBy: input.actor,
  })
  await recordAudit({
    actor: input.actor, action: 'challenge.created', subjectType: 'challenge',
    subjectId: String(challenge.challengeId), payload: { name: input.name, slug },
  })
  log.info('challenge created', { challengeId: challenge.challengeId, slug })
  return challenge
}

export async function getChallenge(challengeId: number): Promise<Challenge> {
  const challenge = await selectChallenge(challengeId)
  if (!challenge) throw new AppError('NOT_FOUND', `Challenge ${challengeId} was not found.`)
  return challenge
}

export async function getChallenges(limit: number, offset: number) {
  const [challenges, total] = await Promise.all([listChallenges(limit, offset), countChallenges()])
  return { challenges, total }
}

export async function setChallengeStatus(
  challengeId: number, status: ChallengeStatus, actor: string,
): Promise<Challenge> {
  const updated = await updateChallengeStatus(challengeId, status)
  if (!updated) throw new AppError('NOT_FOUND', `Challenge ${challengeId} was not found.`)
  await recordAudit({
    actor, action: 'challenge.status_changed', subjectType: 'challenge',
    subjectId: String(challengeId), payload: { status },
  })
  return updated
}

/** Soft delete, permitted only while DRAFT (E02-S01 acceptance 4). */
export async function deleteChallenge(
  challengeId: number, actor: string, reason = 'ADMIN_ACTION',
): Promise<void> {
  const challenge = await getChallenge(challengeId)
  if (challenge.status !== 'DRAFT') {
    throw new AppError(
      'CONFLICT',
      `Challenge ${challengeId} is ${challenge.status}. Only a DRAFT challenge can be deleted; ` +
        `an open or closed challenge has submissions or a rubric depending on it.`,
    )
  }
  const deleted = await softDeleteChallenge(challengeId, actor, reason)
  if (!deleted) throw new AppError('CONFLICT', `Challenge ${challengeId} could not be deleted.`)
  await recordAudit({
    actor, action: 'challenge.deleted', subjectType: 'challenge',
    subjectId: String(challengeId), payload: { reason },
  })
}

export interface UploadInput {
  challengeId: number
  kind: ArtifactKind
  filename: string
  mediaType: string
  content: Buffer
  actor: string
}

/**
 * Accept an uploaded artifact, store it, and extract it immediately.
 *
 * Extraction runs inline rather than as a job: these are a handful of documents uploaded by a
 * person who is watching, and telling them at once that their PDF is a scan is far better than
 * discovering it when generation produces nothing.
 */
export async function uploadArtifact(input: UploadInput): Promise<ChallengeArtifact> {
  const challenge = await getChallenge(input.challengeId)
  if (challenge.status !== 'DRAFT') {
    throw new AppError(
      'CONFLICT',
      `Challenge ${challenge.slug} is ${challenge.status}; brief artifacts can only be added ` +
        `while it is DRAFT.`,
    )
  }

  const maxBytes = await getNumber('platform.max_upload_bytes')
  if (input.content.length > maxBytes) {
    // Names the limit and the file, per E02-S01 acceptance 2.
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `'${input.filename}' is ${formatBytes(input.content.length)}, which exceeds the ` +
        `${formatBytes(maxBytes)} per-file limit.`,
    )
  }
  if (input.content.length === 0) {
    throw new AppError('VALIDATION_FAILED', `'${input.filename}' is empty.`)
  }

  if (!isSupported(input.mediaType, input.filename)) {
    const accepted = supportedFormats().flatMap((f) => f.extensions).join(', ')
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `'${input.filename}' (${input.mediaType}) is not a supported brief format. ` +
        `Accepted: ${accepted}.`,
    )
  }

  const existing = (await selectArtifacts(input.challengeId))
    .find((a) => a.contentHash === hashContent(input.content))
  if (existing) {
    throw new AppError(
      'ALREADY_EXISTS',
      `'${existing.filename}' already holds identical content on this challenge.`,
    )
  }

  const stored = await storeArtifact(input.challengeId, input.content)
  const artifact = await insertArtifact({
    challengeId: input.challengeId,
    kind: input.kind,
    filename: input.filename,
    mediaType: input.mediaType,
    bytes: stored.bytes,
    storageUri: stored.storageUri,
    contentHash: stored.contentHash,
    uploadedBy: input.actor,
  })

  await recordAudit({
    actor: input.actor, action: 'challenge.artifact_uploaded', subjectType: 'challenge',
    subjectId: String(input.challengeId),
    payload: { filename: input.filename, kind: input.kind, bytes: stored.bytes, contentHash: stored.contentHash },
  })

  await extractArtifact(artifact)
  const refreshed = await selectArtifact(artifact.artifactId)
  return refreshed ?? artifact
}

export async function getArtifacts(challengeId: number): Promise<ChallengeArtifact[]> {
  await getChallenge(challengeId)
  return selectArtifacts(challengeId)
}

/** Re-download a retained artifact (E02-S01 acceptance 3). */
export async function downloadArtifact(artifactId: number): Promise<{
  artifact: ChallengeArtifact; content: Buffer
}> {
  const artifact = await selectArtifact(artifactId)
  if (!artifact) throw new AppError('NOT_FOUND', `Artifact ${artifactId} was not found.`)
  return { artifact, content: await readArtifact(artifact.storageUri) }
}

export async function getExtractionHealth(challengeId: number) {
  await getChallenge(challengeId)
  return selectExtractionHealth(challengeId)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
