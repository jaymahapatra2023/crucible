/**
 * All SQL for challenges and their artifacts (P1.2).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type {
  ArtifactKind, Challenge, ChallengeArtifact, ChallengeStatus,
  ExtractedSection, ExtractionHealth, ExtractionStatus,
} from '../types/challengeTypes.js'

interface ChallengeRow {
  challenge_id: number; name: string; slug: string; description: string
  status: ChallengeStatus; created_by: string | null; created_at: Date
}

const toChallenge = (r: ChallengeRow): Challenge => ({
  challengeId: r.challenge_id, name: r.name, slug: r.slug, description: r.description,
  status: r.status, createdBy: r.created_by, createdAt: r.created_at,
})

const COLS = 'challenge_id, name, slug, description, status, created_by, created_at'

export async function insertChallenge(input: {
  name: string; slug: string; description: string; createdBy: string | null
}): Promise<Challenge> {
  const row = await queryOne<ChallengeRow>(
    `INSERT INTO challenge (name, slug, description, created_by)
     VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [input.name, input.slug, input.description, input.createdBy],
  )
  if (!row) throw new Error('insertChallenge returned no row')
  return toChallenge(row)
}

export async function selectChallenge(challengeId: number): Promise<Challenge | null> {
  const row = await queryOne<ChallengeRow>(
    `SELECT ${COLS} FROM challenge WHERE challenge_id = $1 AND deleted_at IS NULL`, [challengeId])
  return row ? toChallenge(row) : null
}

export async function selectChallengeBySlug(slug: string): Promise<Challenge | null> {
  const row = await queryOne<ChallengeRow>(
    `SELECT ${COLS} FROM challenge WHERE slug = $1 AND deleted_at IS NULL`, [slug])
  return row ? toChallenge(row) : null
}

export async function listChallenges(limit: number, offset: number): Promise<Challenge[]> {
  const res = await query<ChallengeRow>(
    `SELECT ${COLS} FROM challenge WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset])
  return res.rows.map(toChallenge)
}

/**
 * The challenges a team may enter, for the public submission form.
 *
 * Deliberately narrow: OPEN only, and nothing but what the form needs. A team submitting an
 * entry needs to pick the right challenge; it does not need the brief, the artefacts, or the
 * existence of the challenges an organiser is still drafting.
 *
 * `rubricSlug` is here for E17-S04: it addresses the PUBLISHED rubric, which is already public
 * by design (P8.1) because a team must be able to read the standard before they are judged by
 * it. It is read from `v_rubric_publications`, the rubrics module's published view (P1.3) — and
 * it is the PUBLICATION's slug, not the challenge's, because that is the key the public rubric
 * endpoint resolves by. Null when nothing has been published, so the form links a standard that
 * exists or says plainly that there is not one yet, rather than offering a link that 404s.
 */
export async function listOpenChallenges(): Promise<Array<{
  challengeId: number; name: string; rubricSlug: string | null
}>> {
  const res = await query<{ challenge_id: number; name: string; rubric_slug: string | null }>(
    `SELECT c.challenge_id, c.name, p.slug AS rubric_slug
       FROM challenge c
       -- Laterally, and newest-first: a challenge re-slugged after a publication has more than
       -- one row in that view, and a plain join would list the challenge twice.
       LEFT JOIN LATERAL (
         SELECT p.slug FROM v_rubric_publications p
          WHERE p.challenge_id = c.challenge_id
          ORDER BY p.published_at DESC LIMIT 1
       ) p ON TRUE
      WHERE c.deleted_at IS NULL AND c.status = 'OPEN' ORDER BY c.name`)
  return res.rows.map((r) => ({
    challengeId: Number(r.challenge_id), name: r.name, rubricSlug: r.rubric_slug,
  }))
}

export async function countChallenges(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM challenge WHERE deleted_at IS NULL')
  return row?.n ?? 0
}

export async function updateChallengeStatus(
  challengeId: number, status: ChallengeStatus,
): Promise<Challenge | null> {
  const row = await queryOne<ChallengeRow>(
    `UPDATE challenge SET status = $2, updated_at = now()
      WHERE challenge_id = $1 AND deleted_at IS NULL RETURNING ${COLS}`,
    [challengeId, status])
  return row ? toChallenge(row) : null
}

/** P7.4 soft delete with a reason code. */
export async function softDeleteChallenge(
  challengeId: number, deletedBy: string, reason: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE challenge SET deleted_at = now(), deleted_by = $2, delete_reason = $3
      WHERE challenge_id = $1 AND deleted_at IS NULL AND status = 'DRAFT'`,
    [challengeId, deletedBy, reason])
  return res.rowCount > 0
}

interface ArtifactRow {
  artifact_id: number; challenge_id: number; kind: ArtifactKind; filename: string
  media_type: string; bytes: number; storage_uri: string; content_hash: string
  extraction_status: ExtractionStatus; extraction_error: string | null
  extracted_text: string | null; extracted_sections: ExtractedSection[]
  extracted_at: Date | null; uploaded_by: string | null; uploaded_at: Date
}

const toArtifact = (r: ArtifactRow): ChallengeArtifact => ({
  artifactId: r.artifact_id, challengeId: r.challenge_id, kind: r.kind, filename: r.filename,
  mediaType: r.media_type, bytes: Number(r.bytes), storageUri: r.storage_uri,
  contentHash: r.content_hash, extractionStatus: r.extraction_status,
  extractionError: r.extraction_error, extractedText: r.extracted_text,
  extractedSections: r.extracted_sections, extractedAt: r.extracted_at,
  uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
})

export async function insertArtifact(input: {
  challengeId: number; kind: ArtifactKind; filename: string; mediaType: string
  bytes: number; storageUri: string; contentHash: string; uploadedBy: string | null
}, client?: DbClient): Promise<ChallengeArtifact> {
  const row = await queryOne<ArtifactRow>(
    `INSERT INTO challenge_artifact
       (challenge_id, kind, filename, media_type, bytes, storage_uri, content_hash, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.challengeId, input.kind, input.filename, input.mediaType, input.bytes,
     input.storageUri, input.contentHash, input.uploadedBy], client)
  if (!row) throw new Error('insertArtifact returned no row')
  return toArtifact(row)
}

export async function selectArtifact(artifactId: number): Promise<ChallengeArtifact | null> {
  const row = await queryOne<ArtifactRow>(
    'SELECT * FROM challenge_artifact WHERE artifact_id = $1', [artifactId])
  return row ? toArtifact(row) : null
}

export async function selectArtifacts(challengeId: number): Promise<ChallengeArtifact[]> {
  const res = await query<ArtifactRow>(
    'SELECT * FROM challenge_artifact WHERE challenge_id = $1 ORDER BY uploaded_at, artifact_id',
    [challengeId])
  return res.rows.map(toArtifact)
}

export async function recordExtraction(input: {
  artifactId: number; status: ExtractionStatus; text: string | null
  sections: ExtractedSection[]; error: string | null
}): Promise<void> {
  await query(
    `UPDATE challenge_artifact
        SET extraction_status = $2, extracted_text = $3, extracted_sections = $4::jsonb,
            extraction_error = $5, extracted_at = now()
      WHERE artifact_id = $1`,
    [input.artifactId, input.status, input.text, JSON.stringify(input.sections), input.error])
}

/** Reads the published view rather than re-aggregating (P1.3). */
export async function selectExtractionHealth(challengeId: number): Promise<ExtractionHealth | null> {
  const row = await queryOne<{
    challenge_id: number; artifacts: number; extracted: number
    failed: number; unsupported: number; extracted_chars: number
  }>('SELECT * FROM v_challenges_extraction_health WHERE challenge_id = $1', [challengeId])
  if (!row) return null
  return {
    challengeId: row.challenge_id, artifacts: Number(row.artifacts),
    extracted: Number(row.extracted), failed: Number(row.failed),
    unsupported: Number(row.unsupported), extractedChars: Number(row.extracted_chars),
  }
}
