/**
 * Fetched supporting documents (P1.2).
 *
 * `text_content` is untrusted, entrant-supplied text. Every read of it is a read of something a
 * competitor wrote knowing a model would see it (P8.4).
 */
import { query, queryOne } from '../../../db/pool.js'

export const ARTIFACT_STATUSES = [
  'FETCHED', 'REFUSED', 'UNREACHABLE', 'TOO_LARGE', 'UNSUPPORTED_TYPE', 'EMPTY',
] as const
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number]

export interface ArtifactRow {
  artifactId: number
  submissionId: number
  url: string
  status: ArtifactStatus
  contentType: string | null
  bytes: number
  textContent: string | null
  detail: string
  fetchedAt: Date
}

interface Row {
  artifact_id: number; submission_id: number; url: string; status: ArtifactStatus
  content_type: string | null; bytes: number; text_content: string | null
  detail: string; fetched_at: Date
}

const COLS = `artifact_id, submission_id, url, status, content_type, bytes, text_content,
              detail, fetched_at`

const toArtifact = (r: Row): ArtifactRow => ({
  artifactId: Number(r.artifact_id), submissionId: Number(r.submission_id), url: r.url,
  status: r.status, contentType: r.content_type, bytes: Number(r.bytes),
  textContent: r.text_content, detail: r.detail, fetchedAt: r.fetched_at,
})

/** Re-fetching replaces the record: the current state of a link is the fact of interest. */
export async function upsertArtifact(input: {
  submissionId: number
  url: string
  status: ArtifactStatus
  contentType: string | null
  bytes: number
  textContent: string | null
  detail: string
  fetchedBy: string
}): Promise<ArtifactRow> {
  const row = await queryOne<Row>(
    `INSERT INTO submission_artifact
       (submission_id, url, status, content_type, bytes, text_content, detail, fetched_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (submission_id, url) DO UPDATE SET
       status       = EXCLUDED.status,
       content_type = EXCLUDED.content_type,
       bytes        = EXCLUDED.bytes,
       text_content = EXCLUDED.text_content,
       detail       = EXCLUDED.detail,
       fetched_at   = now(),
       fetched_by   = EXCLUDED.fetched_by
     RETURNING ${COLS}`,
    [input.submissionId, input.url, input.status, input.contentType, input.bytes,
     input.textContent, input.detail, input.fetchedBy])
  if (!row) throw new Error('upsertArtifact returned no row')
  return toArtifact(row)
}

export async function listArtifacts(submissionId: number): Promise<ArtifactRow[]> {
  const res = await query<Row>(
    `SELECT ${COLS} FROM v_submission_artifact WHERE submission_id = $1 ORDER BY artifact_id`,
    [submissionId])
  return res.rows.map(toArtifact)
}
