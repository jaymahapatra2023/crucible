/**
 * @crucible/scoring — scoring maths and context selection (E06, E07).
 *
 * Pure and testable: no database, no HTTP, no model calls. The model calls themselves live in
 * the API's scoring module behind the gateway (P3.1); what lives here is everything that must be
 * deterministic — which source a criterion is judged against, and how scores combine.
 */
export * from './types.js'
export * from './relevance.js'
export * from './citations.js'
export * from './contextBuilder.js'
export * from './aggregate.js'
export * from './normalise.js'
export * from './composite.js'
export * from './originalitySignals.js'
export * from './principlesDimension.js'
export * from './reviewReasons.js'
export * from './reviewFlags.js'
export * from './calibration.js'
