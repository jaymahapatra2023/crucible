/**
 * Authentication (P8.1) and account management (E09-S03).
 *
 * Sign-in is deliberately uniform on failure: an unknown email and a wrong password produce the
 * same message and comparable timing, so the endpoint is not an account-enumeration oracle.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { hashPassword, verifyPassword } from '../../../lib/password.js'
import { issueToken } from '../../../lib/jwt.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { loadEnv } from '../../../config/env.js'
import type { Role } from '../../../http/auth.js'
import { countUsers, insertUser, listUsers, selectUserByEmail } from '../db/userDb.js'

const log = createLogger('governance', 'identity')

/** Eight hours: long enough for an evaluation evening, short enough to expire overnight. */
const TOKEN_TTL_SECONDS = 8 * 60 * 60

export interface SignInResult {
  token: string
  expiresIn: number
  user: { userId: number; email: string; displayName: string; role: Role }
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const user = await selectUserByEmail(email)

  // Always run a hash comparison so timing does not distinguish "no such user".
  const hash = user?.password_hash ?? '$scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  const matches = await verifyPassword(password, hash)

  if (!user || !user.password_hash || !matches || !user.active) {
    log.warn('sign-in rejected', { email })
    await recordAudit({
      actor: email,
      action: 'auth.sign_in_failed',
      subjectType: 'user',
      subjectId: email,
      payload: { reason: !user ? 'unknown_user' : !user.active ? 'inactive' : 'bad_password' },
    })
    throw new AppError('UNAUTHENTICATED', 'Those sign-in details were not recognised.')
  }

  const token = issueToken(
    { sub: String(user.user_id), role: user.role, email: user.email },
    loadEnv().JWT_SECRET,
    TOKEN_TTL_SECONDS,
  )

  await recordAudit({
    actor: user.email, action: 'auth.signed_in', subjectType: 'user',
    subjectId: String(user.user_id), payload: { role: user.role },
  })

  return {
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    user: {
      userId: user.user_id, email: user.email,
      displayName: user.display_name, role: user.role,
    },
  }
}

export async function createUser(input: {
  email: string
  displayName: string
  password: string
  role: Role
  actor: string
}): Promise<{ userId: number; email: string; role: Role }> {
  if (input.password.length < 12) {
    throw new AppError('VALIDATION_FAILED', 'Password must be at least 12 characters.')
  }
  const row = await insertUser({
    email: input.email,
    displayName: input.displayName,
    passwordHash: await hashPassword(input.password),
    role: input.role,
  })
  await recordAudit({
    actor: input.actor, action: 'user.created', subjectType: 'user',
    subjectId: String(row.user_id), payload: { email: row.email, role: row.role },
  })
  log.info('user created', { userId: row.user_id, role: row.role })
  return { userId: row.user_id, email: row.email, role: row.role }
}

export async function getUsers(limit: number, offset: number) {
  const [rows, total] = await Promise.all([listUsers(limit, offset), countUsers()])
  return {
    users: rows.map((r) => ({
      userId: r.user_id, email: r.email, displayName: r.display_name,
      role: r.role, active: r.active,
    })),
    total,
  }
}
