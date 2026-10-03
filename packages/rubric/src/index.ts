/**
 * @crucible/rubric — the rubric contract (E02-S03).
 *
 * Everything exported here is a published contract (P10.3): scoring, the API and the review UI
 * all compile against it. Changing an export requires updating every consumer in the same change.
 *
 * The package has no database and no network dependency by design — it is the schema, not the
 * storage, so it can be tested and reused without booting anything.
 */
export * from './types.js'
export * from './defaults.js'
export * from './schema.js'
export * from './hash.js'
export * from './validate.js'
export * from './fixtures.js'
