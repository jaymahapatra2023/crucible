/**
 * Challenge and brief-artifact types (E02-S01, E02-S02).
 */

export const CHALLENGE_STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number]

export const ARTIFACT_KINDS = ['BRIEF', 'SUPPORTING', 'RULES', 'DATA_SAMPLE'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const EXTRACTION_STATUSES = ['PENDING', 'EXTRACTED', 'FAILED', 'UNSUPPORTED'] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

export interface Challenge {
  challengeId: number
  name: string
  slug: string
  description: string
  status: ChallengeStatus
  createdBy: string | null
  createdAt: Date
}

/**
 * A located span of brief text. `label` is what a `source_ref` can name — a section heading in a
 * Markdown or DOCX brief, a page number in a PDF. Without it, a generated criterion could not be
 * traced back to the brief, which E02-S03 makes mandatory for CHALLENGE_FIDELITY.
 */
export interface ExtractedSection {
  label: string
  /** Character offset of this section's start within `extractedText`. */
  offset: number
  length: number
}

export interface ChallengeArtifact {
  artifactId: number
  challengeId: number
  kind: ArtifactKind
  filename: string
  mediaType: string
  bytes: number
  storageUri: string
  contentHash: string
  extractionStatus: ExtractionStatus
  extractionError: string | null
  extractedText: string | null
  extractedSections: ExtractedSection[]
  extractedAt: Date | null
  uploadedBy: string | null
  uploadedAt: Date
}

/** Per-challenge extraction coverage, read from the published view. */
export interface ExtractionHealth {
  challengeId: number
  artifacts: number
  extracted: number
  failed: number
  unsupported: number
  extractedChars: number
}
