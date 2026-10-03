/**
 * All SQL for identity. The governance module owns `crucible_user` and `access_token` (P1.3).
 */
import { query, queryOne } from '../../../db/pool.js'
import type { Role } from '../../../http/auth.js'

export interface UserRow {
  user_id: number
  email: string
  display_name: string
  password_hash: string | null
  role: Role
  active: boolean
}

export async function selectUserByEmail(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT user_id, email, display_name, password_hash, role, active
       FROM crucible_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
  )
}

export async function insertUser(input: {
  email: string
  displayName: string
  passwordHash: string
  role: Role
}): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `INSERT INTO crucible_user (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING user_id, email, display_name, password_hash, role, active`,
    [input.email, input.displayName, input.passwordHash, input.role],
  )
  if (!row) throw new Error('insertUser returned no row')
  return row
}

export async function listUsers(limit: number, offset: number): Promise<UserRow[]> {
  const res = await query<UserRow>(
    `SELECT user_id, email, display_name, password_hash, role, active
       FROM crucible_user WHERE deleted_at IS NULL
      ORDER BY email LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return res.rows
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM crucible_user WHERE deleted_at IS NULL',
  )
  return row?.n ?? 0
}
