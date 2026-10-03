/**
 * The one registry that answers "how is this submission built" (P1.5 clauses 3 and 6).
 */
import { commandStrategy } from './commandStrategy.js'
import { dockerfileStrategy } from './dockerfileStrategy.js'
import type { ProbeStrategy } from './probeContract.js'
import type { BuildMethod } from '../types.js'

const STRATEGIES = new Map<BuildMethod, ProbeStrategy>([
  [dockerfileStrategy.method, dockerfileStrategy],
  [commandStrategy.method, commandStrategy],
])

export function strategyFor(method: BuildMethod): ProbeStrategy | null {
  return STRATEGIES.get(method) ?? null
}

export function registerStrategy(strategy: ProbeStrategy): void {
  STRATEGIES.set(strategy.method, strategy)
}

export function supportedMethods(): BuildMethod[] {
  return [...STRATEGIES.keys()]
}
