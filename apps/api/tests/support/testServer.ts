/**
 * Booted-server helper for API contract tests.
 *
 * Uses Fastify's `inject` rather than a real socket: same routing, same hooks, same
 * serialisation, no port. Tests therefore exercise the real auth hook and the real error
 * handler, which is where most contract regressions actually live.
 */
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { hashPassword } from '../../src/lib/password.js'
import { query } from '../../src/db/pool.js'
import type { Role } from '../../src/http/auth.js'

export interface TestUser {
  email: string
  password: string
  role: Role
  token: string
}

let app: FastifyInstance | null = null

export async function getApp(): Promise<FastifyInstance> {
  if (!app) app = await buildServer({ quiet: true, withoutJobs: true })
  return app
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close()
    app = null
  }
}

/** Create a user and sign in, returning a usable bearer token. */
export async function makeUser(role: Role, suffix = ''): Promise<TestUser> {
  const email = `${role}${suffix}@test.local`
  const password = 'test-password-long-enough'
  await query(
    `INSERT INTO crucible_user (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [email, `Test ${role}`, await hashPassword(password), role],
  )

  const server = await getApp()
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  })
  if (res.statusCode !== 200) {
    throw new Error(`Test sign-in failed (${res.statusCode}): ${res.body}`)
  }
  const token = (res.json() as { data: { token: string } }).data.token
  return { email, password, role, token }
}

export function authHeader(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.token}` }
}

/** Register a call key with its config and prompt templates, as a migration would. */
export async function registerTestCallKey(input: {
  callKey: string
  systemPrompt?: string
  userPrompt: string
  model?: string
  maxAttempts?: number
  hasFallback?: boolean
  failureIsTerminal?: boolean
}): Promise<void> {
  await query(
    `INSERT INTO llm_call_registry (call_key, module, purpose, criticality, has_fallback, failure_is_terminal)
     VALUES ($1, 'test', 'test call', 'STANDARD', $2, $3)
     ON CONFLICT (call_key) DO UPDATE SET has_fallback = EXCLUDED.has_fallback,
                                          failure_is_terminal = EXCLUDED.failure_is_terminal`,
    [input.callKey, input.hasFallback ?? false, input.failureIsTerminal ?? false],
  )
  await query(
    `INSERT INTO llm_call_config (call_key, model, max_attempts, timeout_ms)
     VALUES ($1, $2, $3, 5000)
     ON CONFLICT (call_key) DO UPDATE SET model = EXCLUDED.model,
                                          max_attempts = EXCLUDED.max_attempts`,
    [input.callKey, input.model ?? 'claude-sonnet-5', input.maxAttempts ?? 3],
  )
  if (input.systemPrompt !== undefined) {
    await query(
      `INSERT INTO llm_prompt_template (call_key, version, role, body, content_hash, active)
       VALUES ($1, 1, 'system', $2, md5($2) || md5($2), TRUE)
       ON CONFLICT (call_key, role, version) DO UPDATE SET body = EXCLUDED.body`,
      [input.callKey, input.systemPrompt],
    )
  }
  await query(
    `INSERT INTO llm_prompt_template (call_key, version, role, body, content_hash, active)
     VALUES ($1, 1, 'user', $2, md5($2) || md5($2), TRUE)
     ON CONFLICT (call_key, role, version) DO UPDATE SET body = EXCLUDED.body`,
    [input.callKey, input.userPrompt],
  )
}
