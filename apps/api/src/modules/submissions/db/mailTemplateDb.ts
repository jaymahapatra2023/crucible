/** Mail templates (P1.2). Versioned; at most one active per key — see migration 078. */
import { query, queryOne } from '../../../db/pool.js'

export interface MailTemplate {
  templateId: number
  mailKey: string
  version: number
  subject: string
  body: string
  variables: string[]
  contentHash: string
  /** Whether this is the version in use. At most one per key (migration 078). */
  active: boolean
}

interface Row {
  template_id: number; mail_key: string; version: number; subject: string; body: string
  variables: string[]; content_hash: string; active: boolean
}

const COLS = 'template_id, mail_key, version, subject, body, variables, content_hash, active'

const toTemplate = (r: Row): MailTemplate => ({
  templateId: Number(r.template_id), mailKey: r.mail_key, version: Number(r.version),
  subject: r.subject, body: r.body, variables: r.variables, contentHash: r.content_hash,
  active: r.active,
})

export async function selectActiveMailTemplate(mailKey: string): Promise<MailTemplate | null> {
  const row = await queryOne<Row>(
    `SELECT ${COLS} FROM mail_template WHERE mail_key = $1 AND active`, [mailKey])
  return row ? toTemplate(row) : null
}

/** Every template, active or not — for the test that proves the token appears in exactly one. */
export async function listMailTemplates(): Promise<MailTemplate[]> {
  const res = await query<Row>(`SELECT ${COLS} FROM mail_template ORDER BY mail_key, version`)
  return res.rows.map(toTemplate)
}
