/**
 * Secret redaction (P8.3, E01-S03 acceptance 2: "No secret is ever logged, including inside
 * error payloads").
 *
 * Two independent mechanisms, because either alone leaks:
 *
 *  1. **By key name** — anything that *looks* like a credential field is masked regardless of
 *     its value. Catches secrets we never registered.
 *  2. **By value** — every secret loaded at boot is registered here, and any string containing
 *     one is masked wherever it appears. Catches a secret that leaked into a message, a URL, a
 *     stack trace, or a nested error `cause` — the places key-name matching cannot reach.
 */

export const REDACTED = '[REDACTED]'

/** Field names whose value is masked wherever they appear, at any depth. */
const SENSITIVE_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|auth|credential|cookie|session|private[-_]?key|bearer|signature)/i

/** Registered secret values, longest first so overlapping secrets mask maximally. */
let registered: string[] = []

/**
 * Register secret values discovered at boot. Values shorter than 8 characters are ignored —
 * masking a short string would redact unrelated text and make logs unreadable for no gain.
 */
export function registerSecrets(values: readonly (string | undefined)[]): void {
  const next = new Set(registered)
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 8) next.add(v)
  }
  registered = [...next].sort((a, b) => b.length - a.length)
}

/** Test seam — clears the registry. */
export function clearSecrets(): void {
  registered = []
}

/** Mask any registered secret value occurring inside a string. */
export function redactString(input: string): string {
  let out = input
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Deep-redact an arbitrary value for logging. Handles cycles, Errors (including `cause` chains
 * and stacks), Maps, Sets, Buffers and plain objects. Never throws — a logger that throws while
 * reporting a failure loses the failure.
 */
/**
 * Deep-redact an arbitrary value for logging. Handles cycles, Errors (including `cause` chains
 * and stacks), Maps, Sets, Buffers and plain objects. Never throws — a logger that throws while
 * reporting a failure loses the failure.
 */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 12) return '[Object: max depth]'
  if (value === null || value === undefined) return value

  const primitive = redactPrimitive(value)
  if (primitive !== NOT_PRIMITIVE) return primitive

  if (value instanceof Error) return redactError(value, seen, depth)
  if (typeof value === 'object') return redactObject(value, seen, depth)

  return String(value)
}

/** Sentinel: `undefined` and `null` are legitimate redaction results, so they cannot signal
 *  "not handled here". */
const NOT_PRIMITIVE = Symbol('not-primitive')

function redactPrimitive(value: unknown): unknown {
  switch (typeof value) {
    case 'string': return redactString(value)
    case 'number':
    case 'boolean': return value
    case 'bigint': return value.toString()
    case 'function': return '[Function]'
    case 'symbol': return value.toString()
    default: break
  }
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}B]`
  return NOT_PRIMITIVE
}

/**
 * Errors get special handling because the places secrets hide — the message, the stack, and a
 * nested `cause` chain — are exactly the places a generic object walk would miss.
 */
function redactError(value: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: value.name,
    message: redactString(value.message),
  }
  if (value.stack) out['stack'] = redactString(value.stack)
  if (value.cause !== undefined) out['cause'] = redact(value.cause, seen, depth + 1)
  for (const k of Object.keys(value as object)) {
    if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause') continue
    out[k] = SENSITIVE_KEY.test(k)
      ? REDACTED
      : redact((value as unknown as Record<string, unknown>)[k], seen, depth + 1)
  }
  return out
}

function redactObject(value: object, seen: WeakSet<object>, depth: number): unknown {
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1))
  if (value instanceof Set) return [...value].map((v) => redact(v, seen, depth + 1))
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [
        String(k),
        SENSITIVE_KEY.test(String(k)) ? REDACTED : redact(v, seen, depth + 1),
      ]),
    )
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, seen, depth + 1)
  }
  return out
}
