/**
 * SQL for the rubric publication record (E09-S04).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface PublicationRow {
  publication_id: number
  rubric_id: number
  challenge_id: number
  slug: string
  version: number
  content_hash: string
  document_markdown: string
  document_html: string
  document_hash: string
  published_by: string
  published_at: Date
}

export async function insertPublication(input: {
  rubricId: number
  challengeId: number
  slug: string
  version: number
  contentHash: string
  markdown: string
  html: string
  documentHash: string
  publishedBy: string
}): Promise<PublicationRow> {
  const row = await queryOne<PublicationRow>(
    `INSERT INTO rubric_publication
       (rubric_id, challenge_id, slug, version, content_hash,
        document_markdown, document_html, document_hash, published_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [input.rubricId, input.challengeId, input.slug, input.version, input.contentHash,
     input.markdown, input.html, input.documentHash, input.publishedBy])
  if (!row) throw new Error('insertPublication returned no row')
  return row
}

/** The document teams currently see for a challenge slug. */
export async function selectCurrentPublication(slug: string): Promise<PublicationRow | null> {
  return queryOne<PublicationRow>(
    `SELECT * FROM rubric_publication WHERE slug = $1
      ORDER BY published_at DESC, publication_id DESC LIMIT 1`,
    [slug])
}

/**
 * Every publication of a rubric, newest first.
 *
 * A rubric republished after a correction has more than one, and a team may have read either —
 * so the history is listed rather than collapsed to the latest.
 */
export async function selectPublicationHistory(rubricId: number): Promise<PublicationRow[]> {
  const res = await query<PublicationRow>(
    `SELECT * FROM rubric_publication WHERE rubric_id = $1
      ORDER BY published_at DESC, publication_id DESC`,
    [rubricId])
  return res.rows
}
