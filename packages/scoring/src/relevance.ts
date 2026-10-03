/**
 * Deciding which source a criterion should be judged against (E06-S01 acceptance 2).
 *
 * Selection is driven by each criterion's `evidence_spec`, not by a fixed file list. That is the
 * whole point of the story: a fixed list is what made the upstream evaluators score from a
 * summary, and it means a criterion about error handling gets shown the same files as one about
 * data modelling.
 *
 * Deterministic and model-free. A model choosing its own evidence would let it choose evidence
 * that supports the score it already prefers, and would make two runs incomparable (P4.4).
 */

/** Words too common to discriminate between files. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
  'its', 'this', 'that', 'these', 'those', 'can', 'could', 'should', 'would', 'may', 'might',
  'must', 'will', 'shall', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no', 'yes',
  'reader', 'point', 'points', 'pointing', 'code', 'file', 'files', 'submission', 'project',
  'repository', 'repo', 'evidence', 'shows', 'show', 'showing', 'some', 'any', 'all', 'each',
  'there', 'where', 'which', 'what', 'when', 'how', 'who', 'whose', 'than', 'their', 'they',
])

/**
 * Terms a criterion is about.
 *
 * Both singular and plural stems are produced: an evidence spec saying "validates inputs" should
 * match a file containing `validateInput`, and requiring an exact match would miss it.
 */
export function extractTerms(...sources: string[]): string[] {
  const terms = new Set<string>()

  for (const source of sources) {
    // Split on non-letters AND on camelCase boundaries, so `validateInput` yields both parts.
    const words = source
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))

    for (const word of words) {
      terms.add(word)
      // A crude stem: enough to bridge validate/validates/validation without a stemmer.
      if (word.endsWith('s') && word.length > 4) terms.add(word.slice(0, -1))
      if (word.endsWith('ing') && word.length > 6) terms.add(word.slice(0, -3))
      if (word.endsWith('ed') && word.length > 5) terms.add(word.slice(0, -2))
      if (word.endsWith('ion') && word.length > 6) terms.add(word.slice(0, -3))
    }
  }
  return [...terms].sort()
}

export interface TermHit {
  line: number
  /** 1-based line number of the match. */
  text: string
  matched: string[]
}

/** Lines of a file that mention the criterion's terms. */
export function findHits(content: string, terms: readonly string[]): TermHit[] {
  if (terms.length === 0) return []

  const hits: TermHit[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const haystack = line.toLowerCase()
    const matched = terms.filter((t) => haystack.includes(t))
    if (matched.length > 0) {
      hits.push({ line: i + 1, text: line, matched })
    }
  }
  return hits
}

export interface FileRelevance {
  path: string
  score: number
  hits: TermHit[]
  /** Distinct criterion terms the file mentions at all. */
  distinctTerms: number
}

/**
 * Score one file's relevance to a criterion.
 *
 * Distinct terms matter more than raw hit count: a file mentioning "validate", "schema" and
 * "input" once each is far more likely to be the right file than one mentioning "input" thirty
 * times. Counting hits alone would rank a long file with one repeated word above the real answer.
 */
export function scoreFile(
  path: string, content: string, terms: readonly string[],
): FileRelevance {
  const hits = findHits(content, terms)
  const distinct = new Set(hits.flatMap((h) => h.matched))

  let score = distinct.size * 10 + Math.min(hits.length, 20)

  // A path that names the concept is strong evidence the file is about it.
  const pathLower = path.toLowerCase()
  const pathMatches = terms.filter((t) => pathLower.includes(t))
  score += pathMatches.length * 15

  // Tests describe behaviour and are legitimate evidence, but the implementation is the subject.
  if (/(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(path)) score *= 0.7
  // Documentation can support a claim but cannot demonstrate one.
  if (/\.(md|rst|txt)$/i.test(path)) score *= 0.5

  return { path, score: Math.round(score * 10) / 10, hits, distinctTerms: distinct.size }
}

/** Rank files by relevance, most relevant first, ties broken by path for determinism (P4.4). */
export function rankFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
  terms: readonly string[],
): FileRelevance[] {
  return files
    .map((f) => scoreFile(f.path, f.content, terms))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
}
