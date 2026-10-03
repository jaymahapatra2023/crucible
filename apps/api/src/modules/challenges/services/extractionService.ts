/**
 * Brief text extraction (E02-S02).
 *
 * Two properties matter more than throughput:
 *
 *  - **A failure is surfaced per file, never silently skipped, and never fails the batch**
 *    (acceptance 2). One unreadable supporting document must not block a challenge whose brief
 *    parsed perfectly, and a brief that did *not* parse must be impossible to overlook.
 *  - **Extracted text is persisted** (acceptance 3), so generation is repeatable without
 *    re-parsing and so the text the generator actually saw is recoverable during an appeal.
 */
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { readArtifact } from './artifactStorage.js'
import { extractorFor, isSupported } from './extractors/extractorRegistry.js'
import { registerExtractionPort } from '../../../lib/ports/extractionPort.js'
import { recordExtraction, selectArtifact, selectArtifacts } from '../db/challengeDb.js'
import type { ChallengeArtifact, ExtractionStatus } from '../types/challengeTypes.js'

const log = createLogger('challenges', 'extraction')

export interface ExtractionOutcome {
  artifactId: number
  filename: string
  status: ExtractionStatus
  chars: number
  sections: number
  error: string | null
}

/** Extract one artifact. Never throws: the outcome is the return value (acceptance 2). */
export async function extractArtifact(artifact: ChallengeArtifact): Promise<ExtractionOutcome> {
  const base = { artifactId: artifact.artifactId, filename: artifact.filename }

  const extractor = extractorFor(artifact.mediaType, artifact.filename)
  if (!extractor) {
    const error =
      `No extractor handles '${artifact.mediaType}' (${artifact.filename}). ` +
      `Upload the brief as PDF, DOCX, Markdown or plain text.`
    await recordExtraction({
      artifactId: artifact.artifactId, status: 'UNSUPPORTED', text: null, sections: [], error,
    })
    log.warn('artifact format unsupported', { ...base, mediaType: artifact.mediaType })
    return { ...base, status: 'UNSUPPORTED', chars: 0, sections: 0, error }
  }

  try {
    const buffer = await readArtifact(artifact.storageUri)
    const result = await extractor.extract(buffer, artifact.filename)

    await recordExtraction({
      artifactId: artifact.artifactId,
      status: 'EXTRACTED',
      text: result.text,
      sections: result.sections,
      error: null,
    })
    log.info('artifact extracted', {
      ...base, extractor: extractor.name,
      chars: result.text.length, sections: result.sections.length,
    })
    return {
      ...base, status: 'EXTRACTED',
      chars: result.text.length, sections: result.sections.length, error: null,
    }
  } catch (err) {
    const error = errorMessage(err)
    await recordExtraction({
      artifactId: artifact.artifactId, status: 'FAILED', text: null, sections: [], error,
    })
    log.warn('artifact extraction failed', { ...base, extractor: extractor.name, err })
    return { ...base, status: 'FAILED', chars: 0, sections: 0, error }
  }
}

export async function extractOne(artifactId: number): Promise<ExtractionOutcome | null> {
  const artifact = await selectArtifact(artifactId)
  if (!artifact) return null
  return extractArtifact(artifact)
}

/**
 * Extract every artifact on a challenge.
 *
 * Runs sequentially: extraction is CPU- and memory-heavy per file, and a handful of documents
 * per challenge means parallelism buys nothing while making peak memory unpredictable.
 */
export async function extractChallenge(
  challengeId: number,
  actor: string,
): Promise<ExtractionOutcome[]> {
  const artifacts = await selectArtifacts(challengeId)
  const outcomes: ExtractionOutcome[] = []

  for (const artifact of artifacts) {
    outcomes.push(await extractArtifact(artifact))
  }

  const failed = outcomes.filter((o) => o.status !== 'EXTRACTED')
  await recordAudit({
    actor,
    action: 'challenge.extracted',
    subjectType: 'challenge',
    subjectId: String(challengeId),
    payload: {
      artifacts: outcomes.length,
      extracted: outcomes.length - failed.length,
      failures: failed.map((f) => ({ filename: f.filename, status: f.status, error: f.error })),
    },
  })

  if (failed.length > 0) {
    log.warn('challenge extraction completed with failures', {
      challengeId, total: outcomes.length, failed: failed.length,
    })
  }
  return outcomes
}

/**
 * The brief text the generator will read, assembled from every successfully extracted artifact.
 *
 * Each document is fenced with its filename so the model can cite one precisely, and section
 * labels are listed up front so a `source_ref` can name a real location rather than inventing a
 * plausible-sounding one.
 */
export async function assembleBriefText(challengeId: number): Promise<{
  text: string
  sourceCount: number
  sectionLabels: string[]
}> {
  const artifacts = (await selectArtifacts(challengeId))
    .filter((a) => a.extractionStatus === 'EXTRACTED' && a.extractedText)

  const parts: string[] = []
  const sectionLabels: string[] = []

  for (const a of artifacts) {
    const labels = a.extractedSections.map((s) => s.label)
    sectionLabels.push(...labels.map((l) => `${a.filename} :: ${l}`))
    parts.push(
      `===== ${a.kind}: ${a.filename} =====\n` +
      (labels.length > 0 ? `Sections: ${labels.join(' | ')}\n\n` : '\n') +
      a.extractedText,
    )
  }

  return { text: parts.join('\n\n'), sourceCount: artifacts.length, sectionLabels }
}

/**
 * Publish extraction for modules that are not challenges (E36).
 *
 * Registered at boot beside the other ports. The extractors themselves are unchanged and stay
 * here: this exposes the capability, it does not move it.
 */
export function installExtractionPort(): void {
  registerExtractionPort({
    supports: (mediaType, filename) => isSupported(mediaType, filename),

    async extract({ buffer, filename, mediaType }) {
      const extractor = extractorFor(mediaType, filename)
      if (!extractor) {
        return {
          ok: false, text: '',
          detail: `No extractor handles '${mediaType}' (${filename}).`,
        }
      }
      try {
        const result = await extractor.extract(buffer, filename)
        return { ok: true, text: result.text, detail: '' }
      } catch (err) {
        // Never throws, for the same reason `extractArtifact` does not: one unreadable document
        // must not fail the operation that found it.
        return { ok: false, text: '', detail: errorMessage(err) }
      }
    },
  })
}
