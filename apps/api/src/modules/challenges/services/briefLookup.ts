/**
 * Resolve a criterion's `source_ref` to the actual passage of the brief (E02-S06 acceptance 3).
 *
 * Without this, a `source_ref` is an unverifiable claim: the reviewer is shown "brief §2.1" and
 * has no way to check that §2.1 says what the criterion implies. Traceability that cannot be
 * followed is decoration, and it is exactly what an appeal will test.
 *
 * Matching is deliberately fuzzy and deliberately honest about failing: a model writes
 * `source_ref` freely, so an exact match is not achievable, and a wrong passage shown with
 * confidence would be worse than none.
 */
import { selectArtifacts } from '../db/challengeDb.js'
import type { ExtractedSection } from '../types/challengeTypes.js'

export interface BriefSection {
  artifactId: number
  filename: string
  label: string
  text: string
}

export interface BriefPassage {
  sourceRef: string
  matched: boolean
  /** Why nothing matched, when nothing did — shown to the reviewer instead of silence. */
  reason?: string
  section?: BriefSection
}

/** Normalise for comparison: lowercase, strip punctuation and section sigils, collapse space. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[§#*_`]/g, ' ')
    .replace(/[^a-z0-9. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Section-like numbers, e.g. "2.1" from "brief §2.1, para 3". */
function numbersIn(s: string): string[] {
  return [...s.matchAll(/\b\d+(?:\.\d+)*\b/g)].map((m) => m[0])
}

/**
 * Words that appear in almost every citation and carry no discriminating signal. Leaving them in
 * makes "brief §4.1" look similar to every other section that also contains the word "brief".
 */
const CITATION_STOPWORDS = new Set([
  'the', 'and', 'for', 'brief', 'section', 'para', 'paragraph', 'appendix',
  'page', 'see', 'from', 'this', 'that', 'part',
])

const meaningfulWords = (s: string): Set<string> =>
  new Set(s.split(' ').filter((w) => w.length > 2 && !CITATION_STOPWORDS.has(w)))

function score(sourceRef: string, label: string): number {
  const refNorm = normalise(sourceRef)
  const labelNorm = normalise(label)
  if (labelNorm === '') return 0

  // A shared section number is the strongest signal a brief offers.
  const refNumbers = numbersIn(refNorm)
  const labelNumbers = numbersIn(labelNorm)
  const sharedNumber = refNumbers.some((n) => labelNumbers.includes(n))

  const refWords = meaningfulWords(refNorm)
  const labelWords = meaningfulWords(labelNorm)
  let shared = 0
  for (const w of refWords) if (labelWords.has(w)) shared++
  const overlap = refWords.size === 0 ? 0 : shared / refWords.size

  // A shared section number dominates; otherwise word overlap stands on its own. Summing them
  // with a fixed 0.4 weight meant a reference citing a heading by name — "the Detection
  // section" — could never clear the threshold, because it has no number to contribute.
  return sharedNumber ? 0.6 + 0.4 * overlap : overlap
}

/** Every extracted section of a challenge's brief, with its text. */
export async function briefSections(challengeId: number): Promise<BriefSection[]> {
  const artifacts = (await selectArtifacts(challengeId))
    .filter((a) => a.extractionStatus === 'EXTRACTED' && a.extractedText)

  const sections: BriefSection[] = []
  for (const artifact of artifacts) {
    const text = artifact.extractedText as string
    const list: ExtractedSection[] = artifact.extractedSections.length > 0
      ? artifact.extractedSections
      : [{ label: 'document', offset: 0, length: text.length }]

    for (const s of list) {
      sections.push({
        artifactId: artifact.artifactId,
        filename: artifact.filename,
        label: s.label,
        text: text.slice(s.offset, s.offset + s.length).trim(),
      })
    }
  }
  return sections
}

/** Minimum confidence before a passage is offered as the source. */
const MATCH_THRESHOLD = 0.3

export async function resolveSourceRef(
  challengeId: number, sourceRef: string,
): Promise<BriefPassage> {
  const sections = await briefSections(challengeId)
  if (sections.length === 0) {
    return {
      sourceRef, matched: false,
      reason: 'No brief text has been extracted for this challenge, so the reference cannot be checked.',
    }
  }

  let best: BriefSection | null = null
  let bestScore = 0
  for (const section of sections) {
    const s = score(sourceRef, section.label)
    if (s > bestScore) {
      bestScore = s
      best = section
    }
  }

  if (!best || bestScore < MATCH_THRESHOLD) {
    return {
      sourceRef, matched: false,
      reason:
        `No section of the brief matches "${sourceRef}" closely enough to show with confidence. ` +
        `Check the reference by hand before approving this criterion.`,
    }
  }
  return { sourceRef, matched: true, section: best }
}
