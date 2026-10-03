/**
 * Locale-independent string ordering.
 *
 * `String.prototype.localeCompare` depends on the runtime's ICU data and the ambient locale, so
 * two machines can order the same paths differently. For most software that is a cosmetic
 * difference; here it is a correctness one. P4.4 requires repeated scans to produce the same
 * result, and E06-S06 compares two scoring runs — if file ordering could differ between hosts,
 * that comparison would measure the environment rather than the model.
 *
 * Comparing by UTF-16 code unit is total, stable and identical everywhere.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
