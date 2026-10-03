/**
 * What a configuration value is allowed to be (E37).
 *
 * `PATCH /platform/config/:key` validated its body as `z.unknown()`, and `updateConfigValue`
 * wrote whatever it was handed. Two things followed, and the second is the dangerous one:
 *
 *  1. `app_config.value_type` has been declared on every row since E01 and **nothing ever
 *     checked a write against it**. A key declared `number` could be set to `"banana"`.
 *  2. A value of the right *type* but the wrong *shape* was accepted silently. Set
 *     `scans.event_window` to `{"start": ..., "end": ...}` — the wrong field names — and it is
 *     stored, reported as set by the readiness check, and then read by the scanner as `null`,
 *     which **disables provenance windowing** with one `log.warn` nobody sees. Every commit is
 *     then counted as in-window, on an outcome-affecting setting.
 *
 * The declaration lives here once and is used by the writer, by the readiness check and by the
 * scanner (P1.5 clause 6). A schema the writer enforces but the reader re-implements is two
 * schemas that agree until one is edited.
 */
import { z } from 'zod'

/** Hostnames as an allow-list entry: bare host, no scheme, no path, no wildcard. */
const hostname = z.string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    'must be a bare hostname such as github.com — no scheme, path or wildcard')

/**
 * The event window, or null.
 *
 * Null is legitimate and means "do not classify commits by window at all" — different from a
 * malformed value, which used to be indistinguishable from it. Both ends are required together:
 * a window with one end is not a window.
 */
/*
 * `.nullable()` on the object rather than `z.union([z.null(), object])`.
 *
 * A union reports `invalid_union` and buries the real problem inside branch errors, so a
 * mistyped field came back as "Invalid input" — which is the uninformative refusal this whole
 * change exists to stop producing. Nullable keeps the object's own messages ("startsAt Required")
 * at the top level where an operator reads them.
 */
export const eventWindowSchema = z.object({
  // `offset: true` REQUIRES a zone. A bare '2026-10-03' parses as UTC midnight, which moves both
  // edges of the window by the local offset and misclassifies every commit near a boundary.
  startsAt: z.string().datetime({ offset: true, message: 'must be an ISO timestamp with a UTC offset, e.g. 2026-10-03T12:00:00-04:00' }),
  endsAt: z.string().datetime({ offset: true, message: 'must be an ISO timestamp with a UTC offset, e.g. 2026-10-04T12:00:00-04:00' }),
}).refine((w) => new Date(w.endsAt) > new Date(w.startsAt), {
  message: 'endsAt must be after startsAt',
}).nullable()

/**
 * Shapes for the keys where being wrong is silent.
 *
 * Every `json` key is here deliberately. A JSON value that parses is not a value that means
 * anything, and each of these is read by code that assumes a shape: `.some()` over a host list
 * throws on an object, a pricing table with a missing rate silently costs nothing.
 */
export const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'scans.event_window': eventWindowSchema,

  // Non-empty: an empty repository allow-list refuses every submission, which is a state an
  // operator reaches by accident and never on purpose.
  'submissions.allowed_hosts': z.array(hostname).min(1),

  // May be empty — that means "fetch no supporting documents", which is a defensible choice.
  'submissions.artifact_hosts': z.array(hostname),

  'probes.egress_allow_list': z.array(z.string().min(1)),

  'llm.model_pricing': z.record(
    z.string().min(1),
    z.object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
    }),
  ),
}

export type ValueType = 'string' | 'number' | 'boolean' | 'json'

/** The declared type, as a schema. Derived from `value_type` rather than repeated per key. */
const BY_TYPE: Record<ValueType, z.ZodTypeAny> = {
  string: z.string(),
  number: z.number().finite(),
  boolean: z.boolean(),
  // `json` means "structured", not "anything": a bare string stored under a json key is the
  // shape mismatch that makes `getJson<T>`'s cast a lie.
  json: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown()), z.null()]),
}

export interface ValidationResult {
  ok: boolean
  /** Why it was refused, naming the key and what was wrong with it. */
  detail: string
}

/**
 * Check a value against its declared type and, where one exists, its shape.
 *
 * Returns rather than throws: the caller decides whether a bad value is a refused request or a
 * reported finding, and both callers exist.
 */
export function validateConfigValue(input: {
  key: string
  value: unknown
  valueType: string
}): ValidationResult {
  const byType = BY_TYPE[input.valueType as ValueType]
  if (!byType) {
    return { ok: false, detail: `'${input.key}' declares an unknown type '${input.valueType}'.` }
  }

  const typed = byType.safeParse(input.value)
  if (!typed.success) {
    return {
      ok: false,
      detail: `'${input.key}' is declared ${input.valueType}, but the value given is `
        + `${describe(input.value)}.`,
    }
  }

  const shape = CONFIG_SCHEMAS[input.key]
  if (!shape) return { ok: true, detail: '' }

  const parsed = shape.safeParse(input.value)
  if (!parsed.success) {
    return {
      ok: false,
      detail: `'${input.key}' does not have the right shape: ${problems(parsed.error)}.`,
    }
  }
  return { ok: true, detail: '' }
}

/**
 * Every problem at once. Fixing one field to be told about the next is a poor use of anyone.
 *
 * Union errors are flattened rather than reported as "Invalid input": a union's own message says
 * only that no branch matched, which tells an operator nothing they can act on.
 */
function problems(error: z.ZodError): string {
  const flat = error.issues.flatMap((issue) =>
    issue.code === 'invalid_union'
      ? issue.unionErrors.flatMap((e) => e.issues)
      : [issue])

  const seen = new Set<string>()
  const described: string[] = []
  for (const i of flat) {
    const text = i.path.length > 0 ? `${i.path.join('.')} ${i.message}` : i.message
    if (seen.has(text)) continue
    seen.add(text)
    described.push(text)
  }
  return described.join('; ')
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}
