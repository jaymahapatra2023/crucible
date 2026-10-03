/**
 * Metrics derived from the gathered files (E04-S01, feeding E06-S04).
 *
 * Facts, not judgements. "Has tests" is a fact; "is well tested" is a score, and scoring belongs
 * to E06 where it can be weighed against a rubric and carry evidence. Keeping the split sharp is
 * what stops a metric quietly becoming a grade nobody agreed to.
 */
import { lineCommentPrefixes } from './languages.js'
import type { RepoMarkers } from './repoMarkers.js'
import type { CodeMetrics, ScannedFile } from './types.js'

/** Files over this many lines are recorded — a structural signal, deliberately not a verdict. */
const LONG_FILE_LINES = 400

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|^test_/i

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path)
}

export function computeMetrics(
  files: readonly ScannedFile[],
  markers: RepoMarkers,
): CodeMetrics {
  let totalLines = 0
  let codeLines = 0
  let commentLines = 0
  let blankLines = 0
  let maxFileLines = 0
  const longFiles: string[] = []
  const languages = new Set<string>()

  for (const file of files) {
    languages.add(file.language)
    totalLines += file.lines
    maxFileLines = Math.max(maxFileLines, file.lines)
    if (file.lines > LONG_FILE_LINES) longFiles.push(file.path)

    const split = splitLines(file)
    codeLines += split.code
    commentLines += split.comment
    blankLines += split.blank
  }

  const testFiles = files.filter((f) => isTestFile(f.path))

  return {
    filesAnalysed: files.length,
    totalLines,
    codeLines,
    commentLines,
    blankLines,
    languages: [...languages].sort(),
    longFiles: longFiles.sort(),
    maxFileLines,
    averageFileLines: files.length === 0 ? 0 : Math.round(totalLines / files.length),
    hasTests: testFiles.length > 0,
    testFileCount: testFiles.length,
    // Presence signals come from a direct filesystem check, because the files that carry them
    // (lockfiles above all) are deliberately excluded from the file budget.
    hasCi: markers.hasCi,
    hasDockerfile: markers.hasDockerfile,
    hasReadme: markers.hasReadme,
    hasLockfile: markers.hasLockfile,
    dependencyCount: countDependencies(files),
  }
}

interface LineSplit { code: number; comment: number; blank: number }

/**
 * Split a file into code, comment and blank lines.
 *
 * Line comments and the common C-style block form are handled; a comment marker inside a
 * string literal will be miscounted. That is accepted: these counts are a coarse signal shown
 * beside a score (E06-S04 acceptance 3), not an input to a threshold, and a full parser per
 * language would be a large cost for a rounding difference.
 */
export function splitLines(file: ScannedFile): LineSplit {
  const prefixes = lineCommentPrefixes(file.language)
  let code = 0
  let comment = 0
  let blank = 0
  let inBlock = false

  for (const rawLine of file.content.split('\n')) {
    const line = rawLine.trim()

    if (inBlock) {
      comment++
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line === '') {
      blank++
      continue
    }
    if (line.startsWith('/*')) {
      comment++
      if (!line.includes('*/')) inBlock = true
      continue
    }
    if (prefixes.some((p) => line.startsWith(p))) {
      comment++
      continue
    }
    code++
  }

  return { code, comment, blank }
}

/** Direct dependencies declared in a manifest. Zero when no manifest was read. */
function countDependencies(files: readonly ScannedFile[]): number {
  let count = 0

  for (const file of files) {
    const name = file.path.split('/').pop() ?? ''

    if (name === 'package.json') {
      try {
        const parsed = JSON.parse(file.content) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        count += Object.keys(parsed.dependencies ?? {}).length
        count += Object.keys(parsed.devDependencies ?? {}).length
      } catch {
        // A manifest that does not parse is itself worth noticing, but not here — the metric
        // stays a count and says nothing it cannot support.
      }
      continue
    }
    if (name === 'requirements.txt') {
      count += file.content.split('\n')
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length
      continue
    }
    if (name === 'go.mod') {
      count += (file.content.match(/^\s+[\w.\-/]+\s+v\d/gm) ?? []).length
      continue
    }
    if (name === 'Cargo.toml' || name === 'pyproject.toml') {
      const section = /\[(dependencies|tool\.poetry\.dependencies|project\.dependencies)\]([\s\S]*?)(\n\[|$)/
        .exec(file.content)
      if (section?.[2]) {
        count += section[2].split('\n').filter((l) => /^\s*[\w.\-"]+\s*=/.test(l)).length
      }
    }
  }
  return count
}
