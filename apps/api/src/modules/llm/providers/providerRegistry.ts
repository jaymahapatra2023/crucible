/**
 * The one registry that answers "which provider handles this call" (P1.5 clause 3 and 6).
 *
 * There is exactly one dispatcher on the provider axis. Adding a provider is one strategy file
 * plus one line here — no second lookup table to hand-sync.
 */
import { createLogger } from '../../../lib/logger.js'
import { anthropicProvider } from './anthropicProvider.js'
import { cliProvider } from './cliProvider.js'
import { ProviderError, type ModelProvider } from './providerContract.js'

const log = createLogger('llm', 'providerRegistry')

const BUILT_IN: readonly ModelProvider[] = [anthropicProvider, cliProvider]

const providers = new Map<string, ModelProvider>(BUILT_IN.map((p) => [p.name, p]))

/**
 * Ordered preference when no provider is named. First available wins.
 *
 * HTTP first: it is faster, poolable, and its cost is computed from Crucible's own price table.
 * The CLI is the fallback for a machine that has the tool but no key — deliberately second, so
 * that configuring a key changes which path is used without changing anything else.
 */
const PREFERENCE: readonly string[] = ['anthropic', 'cli']

export function registerProvider(provider: ModelProvider): void {
  providers.set(provider.name, provider)
  log.info('provider registered', { provider: provider.name })
}

/** Test seam — restores the built-in set. */
export function resetProviders(): void {
  providers.clear()
  for (const p of BUILT_IN) providers.set(p.name, p)
}

export function providerFor(name?: string): ModelProvider {
  if (name) {
    const p = providers.get(name)
    if (!p) throw new ProviderError('UNAVAILABLE', `No provider registered under '${name}'.`)
    return p
  }
  for (const preferred of PREFERENCE) {
    const p = providers.get(preferred)
    if (p?.isAvailable()) return p
  }
  for (const p of providers.values()) {
    if (p.isAvailable()) return p
  }
  throw new ProviderError(
    'UNAVAILABLE',
    'No LLM provider is available. Set ANTHROPIC_API_KEY for the HTTP path, or LLM_CLI_BINARY '
      + 'to reach a model through a locally installed CLI.',
  )
}

export function listProviders(): Array<{ name: string; available: boolean }> {
  return [...providers.values()].map((p) => ({ name: p.name, available: p.isAvailable() }))
}
