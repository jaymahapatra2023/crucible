/**
 * Resolve everything one gateway call needs from the database, once (P3.2, P3.3, P3.6).
 *
 * Separated from the attempt loop so that "is this call properly registered, configured and
 * prompted" is answered in one place and fails with one clear message per cause. An
 * unregistered key, a missing config row and a missing template are three different operator
 * mistakes and deserve three different errors.
 */
import { randomUUID } from 'node:crypto'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { selectActiveTemplate, selectCallConfig, selectRegistration } from '../db/llmRegistryDb.js'
import { renderPrompt } from './promptRenderer.js'
import type { CallModelInput, ResolvedCall } from '../types/llmTypes.js'

const log = createLogger('llm', 'callResolver')

export async function resolveCall<T>(input: CallModelInput<T>): Promise<ResolvedCall> {
  const { callKey } = input

  const registration = await selectRegistration(callKey)
  if (!registration) {
    throw new AppError(
      'INTERNAL_ERROR',
      `LLM call key '${callKey}' is not registered. Register it in llm_call_registry before ` +
        `calling it (P3.2) — an unregistered call has no config, no prompt and no audit.`,
    )
  }

  const config = await selectCallConfig(callKey)
  if (!config) {
    throw new AppError('INTERNAL_ERROR', `LLM call key '${callKey}' has no configuration row.`)
  }

  const userTemplate = await selectActiveTemplate(callKey, 'user')
  if (!userTemplate) {
    throw new AppError(
      'INTERNAL_ERROR',
      `LLM call key '${callKey}' has no active user prompt template. Prompts are database rows, ` +
        `not literals (P3.3).`,
    )
  }
  const systemTemplate = (await selectActiveTemplate(callKey, 'system'))?.body ?? ''

  const rendered = renderPrompt({
    systemTemplate,
    userTemplate: userTemplate.body,
    variables: input.variables ?? {},
    untrusted: input.untrusted ?? [],
  }, randomUUID())

  if (rendered.findings.length > 0) {
    // P8.4 clause 4: surfaced for human review, never silently stripped and scored anyway.
    log.warn('prompt injection patterns detected in untrusted content', {
      callKey,
      findings: rendered.findings.map((f) => ({ label: f.label, pattern: f.pattern })),
    })
  }

  return {
    registration,
    config,
    systemPrompt: rendered.system,
    userPrompt: rendered.user,
    injectionFindings: rendered.findings,
  }
}

/** Whether the call is switched off by configuration (P3.6). */
export function isDisabled(resolved: ResolvedCall): boolean {
  return !resolved.config.enabled
}
