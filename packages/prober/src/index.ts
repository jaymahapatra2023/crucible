/**
 * @crucible/prober — sandboxed build-and-run probing for untrusted submissions (E05).
 *
 * The package assumes every submission is hostile (P8.6). Containment lives in
 * `sandboxPolicy.ts`, applies to every strategy, and is verified by an adversarial fixture that
 * CI runs on every change.
 */
export * from './types.js'
export * from './sandboxPolicy.js'
export * from './sandboxSignatures.js'
export * from './baseImages.js'
export * from './logCapture.js'
export * from './containerRuntime.js'
export * from './strategies/probeContract.js'
export * from './strategies/strategyRegistry.js'
export * from './probe.js'
// Adversarial fixtures, exported so the security gate can run from the API suite too (P8.6).
export * from './hostileFixtures.js'
