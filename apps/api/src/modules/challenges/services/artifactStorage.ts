/**
 * Retained storage for uploaded brief artifacts (E02-S01 acceptance 3).
 *
 * Files are kept and remain re-downloadable after the event, because the rubric must stay
 * traceable to its source: an appeal six months later asks "what did the brief actually say",
 * and "we parsed it at the time" is not an answer.
 *
 * Content-addressed by SHA-256, so re-uploading the same file costs nothing and a stored file
 * can always be shown to be the one that was ingested.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from '../../../config/env.js'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'

const log = createLogger('challenges', 'artifactStorage')

export interface StoredArtifact {
  storageUri: string
  contentHash: string
  bytes: number
}

function rootDir(): string {
  const env = loadEnv()
  return join(env.WORKSPACE_ROOT ?? join(tmpdir(), 'crucible'), 'artifacts')
}

export function hashContent(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Store a file and return its address.
 *
 * The hash prefix becomes a directory so a single flat folder never accumulates thousands of
 * entries, which makes both the filesystem and a human inspecting it miserable.
 */
export async function storeArtifact(challengeId: number, buffer: Buffer): Promise<StoredArtifact> {
  const contentHash = hashContent(buffer)
  const dir = join(rootDir(), String(challengeId), contentHash.slice(0, 2))
  await mkdir(dir, { recursive: true })

  const path = join(dir, contentHash)
  await writeFile(path, buffer)
  log.info('artifact stored', { challengeId, contentHash, bytes: buffer.length })

  return { storageUri: `file://${path}`, contentHash, bytes: buffer.length }
}

/** Read a stored artifact back, for re-download or re-extraction. */
export async function readArtifact(storageUri: string): Promise<Buffer> {
  if (!storageUri.startsWith('file://')) {
    throw new AppError('INTERNAL_ERROR', `Unsupported artifact storage scheme: ${storageUri}`)
  }
  const path = storageUri.slice('file://'.length)
  try {
    return await readFile(path)
  } catch (err) {
    throw new AppError(
      'NOT_FOUND',
      'The stored file for this artifact could not be read. The rubric can no longer be traced ' +
        'to its source, which is a governance problem, not only a missing file.',
      { cause: err },
    )
  }
}

export async function artifactExists(storageUri: string): Promise<boolean> {
  if (!storageUri.startsWith('file://')) return false
  try {
    await stat(storageUri.slice('file://'.length))
    return true
  } catch {
    return false
  }
}
