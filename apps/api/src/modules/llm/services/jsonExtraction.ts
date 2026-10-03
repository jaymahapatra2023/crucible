/**
 * Extract a JSON value from model output (E01-S04 acceptance 3, E04-S02 acceptance 2).
 *
 * Models wrap JSON in prose, in fenced code blocks, or truncate it when a token budget runs out.
 * This is the one repair pass the gateway permits: if it fails, the call fails loudly rather
 * than a second model call being spent guessing (P4.2 — after the classified retries, fail).
 *
 * Deliberately dependency-free and pure, so it is exhaustively unit-testable.
 */

export interface ExtractionResult {
  ok: boolean
  value?: unknown
  /** How the JSON was recovered — recorded so repair rates are observable (P9.3). */
  method?: 'direct' | 'fenced' | 'balanced-scan' | 'repaired-truncation'
  error?: string
}

/** Fenced block, optionally tagged ```json. Non-greedy so the first complete block wins. */
const FENCE = /```(?:json|jsonc)?\s*\n?([\s\S]*?)```/i

export function extractJson(text: string): ExtractionResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'Model returned empty output.' }
  }

  const direct = tryParse(text.trim())
  if (direct.ok) return { ok: true, value: direct.value, method: 'direct' }

  const fenced = FENCE.exec(text)
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim())
    if (parsed.ok) return { ok: true, value: parsed.value, method: 'fenced' }
  }

  // Unterminated fence — the model was cut off mid-block. Take everything after the opener.
  const openFence = /```(?:json|jsonc)?\s*\n?([\s\S]*)$/i.exec(text)
  const candidates = [text]
  if (openFence?.[1]) candidates.unshift(openFence[1])

  for (const candidate of candidates) {
    const scanned = balancedScan(candidate)
    if (scanned.ok) return { ok: true, value: scanned.value, method: 'balanced-scan' }

    const repaired = repairTruncation(candidate)
    if (repaired.ok) return { ok: true, value: repaired.value, method: 'repaired-truncation' }
  }

  return { ok: false, error: 'No parseable JSON object or array found in the model output.' }
}

function tryParse(s: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

/**
 * Find the first balanced `{...}` or `[...]`, respecting strings and escapes so a brace inside
 * a string literal does not end the scan early.
 */
function balancedScan(text: string): { ok: boolean; value?: unknown } {
  const start = firstStructuralIndex(text)
  if (start < 0) return { ok: false }

  const open = text[start] as '{' | '['
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const c = text[i] as string
    if (escaped) { escaped = false; continue }
    if (c === '\\') { if (inString) escaped = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return tryParse(text.slice(start, i + 1))
    }
  }
  return { ok: false }
}

function firstStructuralIndex(text: string): number {
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  if (brace < 0) return bracket
  if (bracket < 0) return brace
  return Math.min(brace, bracket)
}

/**
 * Repair output truncated mid-structure by closing what is still open.
 *
 * Only ever *adds* closing punctuation — it never invents a value, so a repaired parse cannot
 * fabricate content. A trailing partial key/value is dropped, which is why the caller still
 * schema-validates the result (P4.1): a repair that loses a required field fails validation
 * rather than passing silently.
 */
interface StructuralScan {
  /** Open containers, innermost last. */
  stack: Array<'{' | '['>
  /** Index of the last position at which the text could be safely cut. */
  lastSafe: number
}

/**
 * Walk the text tracking string state, escapes and container nesting.
 *
 * Container *kind* is tracked, not just depth, because the correct repair differs: a trailing
 * bare string is a dangling KEY inside an object but a complete VALUE inside an array, and
 * conflating the two silently deletes real data.
 */
function scanStructure(text: string, start: number): StructuralScan {
  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  let lastSafe = -1

  for (let i = start; i < text.length; i++) {
    const c = text[i] as string
    if (escaped) { escaped = false; continue }
    if (c === '\\') { if (inString) escaped = true; continue }
    if (c === '"') { inString = !inString; if (!inString) lastSafe = i; continue }
    if (inString) continue
    if (c === '{' || c === '[') stack.push(c as '{' | '[')
    else if (c === '}' || c === ']') { stack.pop(); lastSafe = i }
    else if (c === ',' || /[\d\w]/.test(c)) lastSafe = i
  }

  return { stack, lastSafe }
}

/**
 * Repair output truncated mid-structure by closing what is still open.
 *
 * Only ever *adds* closing punctuation — it never invents a value, so a repaired parse cannot
 * fabricate content. A trailing partial key/value is dropped, which is why the caller still
 * schema-validates the result (P4.1): a repair that loses a required field fails validation
 * rather than passing silently.
 */
function repairTruncation(text: string): { ok: boolean; value?: unknown } {
  const start = firstStructuralIndex(text)
  if (start < 0) return { ok: false }

  const { stack, lastSafe } = scanStructure(text, start)
  if (stack.length === 0 || lastSafe < 0) return { ok: false }

  let body = text.slice(start, lastSafe + 1).replace(/,\s*$/, '')

  // Inside an object, a trailing key with no value (with or without its colon) cannot be closed
  // honestly — drop the pair. Inside an array, that same text is a complete value: leave it.
  if (stack[stack.length - 1] === '{') {
    body = body.replace(/,?\s*"[^"]*"\s*:?\s*$/, '')
  }
  body = body.replace(/,\s*$/, '')

  const closers = stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('')
  return tryParse(body + closers)
}
