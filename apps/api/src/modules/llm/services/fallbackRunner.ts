/**
 * Deterministic non-LLM fallbacks (P3.5).
 *
 * A fallback is rule-based, fast (< 100 ms) and declared in `llm_fallback_rule`. It exists so a
 * provider outage degrades a non-critical feature instead of failing it.
 *
 * **What has no fallback, by design:** a criterion score. P3.5's stated exception holds that
 * where judgement cannot be obtained, the honest output is `SCORING_FAILED` or
 * `insufficient_evidence` — never a synthesised number. Those call keys set
 * `failure_is_terminal = TRUE` and never reach this file.
 */
import { z } from 'zod'
import { queryOne } from '../../../db/pool.js'
import { createLogger } from '../../../lib/logger.js'
import type { CallModelInput } from '../types/llmTypes.js'

const log = createLogger('llm', 'fallback')

const STRATEGIES = ['RULE_BASED', 'PASSTHROUGH', 'TEMPLATE_RETURN', 'SHA256_DEDUP', 'FIELD_FORMULA'] as const
type Strategy = (typeof STRATEGIES)[number]

/** The DB constraint already restricts this column, but the service does not trust the layer
 *  below it for a value that selects executable behaviour (P8.5). */
function isStrategy(value: string): value is Strategy {
  return (STRATEGIES as readonly string[]).includes(value)
}

interface FallbackRule {
  strategy: Strategy
  config: Record<string, unknown>
}

async function selectRule(callKey: string): Promise<FallbackRule | null> {
  const row = await queryOne<{ strategy: string; config: Record<string, unknown> }>(
    'SELECT strategy, config FROM llm_fallback_rule WHERE call_key = $1',
    [callKey],
  )
  if (!row) return null
  if (!isStrategy(row.strategy)) {
    log.error('unknown fallback strategy configured; refusing to run it', {
      callKey, strategy: row.strategy,
    })
    return null
  }
  return { strategy: row.strategy, config: row.config }
}

/**
 * Produce a fallback result, or null when none is declared or the declared one cannot satisfy
 * the caller's schema. Returning null is correct: an unvalidated fallback is worse than none,
 * because downstream code would treat fabricated shape as real (P4.1).
 */
export async function runFallback<T>(
  callKey: string,
  input: CallModelInput<T>,
): Promise<T | null> {
  const rule = await selectRule(callKey)
  if (!rule) {
    log.warn('registry declares a fallback but no rule is configured', { callKey })
    return null
  }

  const produced = produce(rule, input)
  if (produced === undefined) return null

  const parsed = input.schema.safeParse(produced)
  if (!parsed.success) {
    log.error('fallback output failed schema validation; refusing to return it', {
      callKey,
      strategy: rule.strategy,
      issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
    })
    return null
  }
  log.warn('fallback served', { callKey, strategy: rule.strategy })
  return parsed.data
}

function produce<T>(rule: FallbackRule, input: CallModelInput<T>): unknown {
  switch (rule.strategy) {
    case 'TEMPLATE_RETURN':
      return rule.config['value']
    case 'PASSTHROUGH':
      return input.variables ?? {}
    case 'FIELD_FORMULA':
      return applyFormula(rule.config, input.variables ?? {})
    case 'RULE_BASED':
      return rule.config['value']
    case 'SHA256_DEDUP':
      return rule.config['value']
    default:
      return undefined
  }
}

const formulaSchema = z.object({
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
})

/** Build an object from configured literals and `{{variable}}` references. */
function applyFormula(
  config: Record<string, unknown>,
  variables: Record<string, string | number | boolean>,
): unknown {
  const parsed = formulaSchema.safeParse(config)
  if (!parsed.success) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(parsed.data.fields)) {
    if (typeof spec === 'string') {
      const ref = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(spec)
      out[key] = ref?.[1] ? variables[ref[1]] : spec
    } else {
      out[key] = spec
    }
  }
  return out
}
