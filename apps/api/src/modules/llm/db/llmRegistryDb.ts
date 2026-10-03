/**
 * All SQL for the LLM call registry, per-key config and prompt templates (P3.2, P3.3, P3.6).
 */
import { query, queryOne } from '../../../db/pool.js'
import type { CallConfig, CallRegistration, Criticality, PromptTemplate } from '../types/llmTypes.js'

interface RegistryRow {
  call_key: string; module: string; purpose: string; criticality: Criticality
  input_variables: string[]; has_fallback: boolean
  failure_is_terminal: boolean; requires_review: boolean
}

const toRegistration = (r: RegistryRow): CallRegistration => ({
  callKey: r.call_key, module: r.module, purpose: r.purpose, criticality: r.criticality,
  inputVariables: r.input_variables, hasFallback: r.has_fallback,
  failureIsTerminal: r.failure_is_terminal, requiresReview: r.requires_review,
})

export async function selectRegistration(callKey: string): Promise<CallRegistration | null> {
  const row = await queryOne<RegistryRow>(
    `SELECT call_key, module, purpose, criticality, input_variables,
            has_fallback, failure_is_terminal, requires_review
       FROM llm_call_registry WHERE call_key = $1`,
    [callKey],
  )
  return row ? toRegistration(row) : null
}

export async function selectAllRegistrations(): Promise<CallRegistration[]> {
  const res = await query<RegistryRow>(
    `SELECT call_key, module, purpose, criticality, input_variables,
            has_fallback, failure_is_terminal, requires_review
       FROM llm_call_registry ORDER BY call_key`,
  )
  return res.rows.map(toRegistration)
}

interface ConfigRow {
  call_key: string; model: string; fallback_model: string | null; max_tokens: number
  temperature: number; timeout_ms: number; max_attempts: number
  log_prompts: boolean; log_responses: boolean; enabled: boolean
}

export async function selectCallConfig(callKey: string): Promise<CallConfig | null> {
  const row = await queryOne<ConfigRow>(
    `SELECT call_key, model, fallback_model, max_tokens, temperature, timeout_ms,
            max_attempts, log_prompts, log_responses, enabled
       FROM llm_call_config WHERE call_key = $1`,
    [callKey],
  )
  if (!row) return null
  return {
    callKey: row.call_key, model: row.model, fallbackModel: row.fallback_model,
    maxTokens: row.max_tokens, temperature: Number(row.temperature),
    timeoutMs: row.timeout_ms, maxAttempts: row.max_attempts,
    logPrompts: row.log_prompts, logResponses: row.log_responses, enabled: row.enabled,
  }
}

interface TemplateRow {
  template_id: number; call_key: string; version: number
  role: 'system' | 'user'; body: string; content_hash: string
}

/** The active template for a (call_key, role). At most one is active — enforced by a unique index. */
export async function selectActiveTemplate(
  callKey: string,
  role: 'system' | 'user',
): Promise<PromptTemplate | null> {
  const row = await queryOne<TemplateRow>(
    `SELECT template_id, call_key, version, role, body, content_hash
       FROM llm_prompt_template WHERE call_key = $1 AND role = $2 AND active`,
    [callKey, role],
  )
  if (!row) return null
  return {
    templateId: row.template_id, callKey: row.call_key, version: row.version,
    role: row.role, body: row.body, contentHash: row.content_hash,
  }
}
