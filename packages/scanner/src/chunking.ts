import { compareStrings } from './ordering.js'
/**
 * Deterministic chunking and merging.
 *
 * P4.4 requires chunk-and-merge rather than a random drop on budget overflow, and requires
 * stable ordering: two scans of the same commit must read the same files in the same order, or
 * the double-run comparison in E06-S06 measures the scanner's nondeterminism instead of the
 * model's.
 */

/** Split into fixed-size batches, preserving order. */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`Chunk size must be at least 1; got ${size}.`)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * Split into batches bounded by a byte budget rather than a count.
 *
 * A single oversized item still gets its own batch: dropping it would silently remove content
 * from the scan, which is the behaviour P4.4 forbids.
 */
export function chunkByBytes<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  maxBytes: number,
): T[][] {
  const out: T[][] = []
  let current: T[] = []
  let currentBytes = 0

  for (const item of items) {
    const bytes = sizeOf(item)
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      out.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += bytes
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Merge partial results by unioning on a key and keeping the highest-confidence entry.
 *
 * Explicit union, never last-write-wins: analysing the same symbol in two chunks must not make
 * the result depend on which chunk finished last.
 */
export function mergeByKey<T>(
  batches: ReadonlyArray<readonly T[]>,
  keyOf: (item: T) => string,
  preferOf: (a: T, b: T) => T,
): T[] {
  const merged = new Map<string, T>()
  for (const batch of batches) {
    for (const item of batch) {
      const key = keyOf(item)
      const existing = merged.get(key)
      merged.set(key, existing ? preferOf(existing, item) : item)
    }
  }
  // Sorted by key so the merged order is a property of the content, not of arrival order.
  return [...merged.entries()].sort((a, b) => compareStrings(a[0], b[0])).map(([, v]) => v)
}
