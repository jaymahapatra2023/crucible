/**
 * Token cost attribution (P9.3, E01-S04 acceptance 4, E10-S03).
 *
 * Pricing is configuration, not a constant (P3.6) — it changes without a redeploy and a run's
 * pinned config records what was in force when it ran.
 */
import { getJson } from '../../platform/services/configService.js'
import { createLogger } from '../../../lib/logger.js'
import type { TokenUsage } from '../types/llmTypes.js'

const log = createLogger('llm', 'cost')

export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
}

export type PricingTable = Record<string, ModelPrice>

const PRICING_KEY = 'llm.model_pricing'

export async function getPricing(): Promise<PricingTable> {
  return getJson<PricingTable>(PRICING_KEY)
}

/**
 * USD cost of one call. An unpriced model costs 0 and warns loudly rather than throwing: a
 * missing price must not fail a scoring call, but it must not silently under-report spend
 * against the ceiling either.
 */
export async function estimateCost(model: string, usage: TokenUsage): Promise<number> {
  const pricing = await getPricing()
  const price = pricing[model]
  if (!price) {
    log.warn('no price configured for model; cost recorded as 0', { model })
    return 0
  }
  const cost =
    (usage.tokensIn / 1_000_000) * price.inputPerMTok +
    (usage.tokensOut / 1_000_000) * price.outputPerMTok
  return Math.round(cost * 1_000_000) / 1_000_000
}

/** Pure variant for unit tests and for projecting spend without a DB read. */
export function computeCost(price: ModelPrice, usage: TokenUsage): number {
  const cost =
    (usage.tokensIn / 1_000_000) * price.inputPerMTok +
    (usage.tokensOut / 1_000_000) * price.outputPerMTok
  return Math.round(cost * 1_000_000) / 1_000_000
}
