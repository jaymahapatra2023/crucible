/**
 * Originality signals (E06-S05 acceptance 1).
 *
 * These measurements feed an advisory judgement about whether a team did their own work, so the
 * tests concentrate on the ways a heuristic like this defames someone: counting a framework's
 * files as the team's, counting the team's files as the framework's, or reporting a share over
 * a sample as though it were over the repository.
 */
import { describe, expect, it } from 'vitest'
import type { ScanResult, ScannedFile } from '@crucible/scanner'
import {
  boilerplateShare, classifyFile, describeOriginality, detectTemplates, generatedPaths,
  originalitySignals, TEMPLATE_MARKERS,
} from './originalitySignals.js'

function file(path: string, content = 'const x = 1', lines = 10): ScannedFile {
  return { path, bytes: content.length, lines, language: 'typescript', content, truncated: false }
}

function scan(files: ScannedFile[], overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    commitSha: 'abc123', headCommittedAt: null, files,
    stats: {
      totalFiles: files.length, sourceFiles: files.length, totalBytes: 0,
      byLanguage: {}, topDirectories: [], recommendedDepth: 'standard',
    },
    metrics: {
      filesAnalysed: files.length, totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0,
      languages: [], longFiles: [], maxFileLines: 0, averageFileLines: 0,
      hasTests: false, testFileCount: 0, hasCi: false, hasDockerfile: false,
      hasReadme: false, hasLockfile: false, dependencyCount: 0,
    },
    provenance: null,
    filesAnalysed: files.length, filesTotal: files.length,
    budgetTruncated: false, scannedAt: '2026-01-01T00:00:00Z', durationMs: 1,
    ...overrides,
  }
}

describe('template detection', () => {
  it('recognises Create React App from a file it always writes', () => {
    const matches = detectTemplates([
      file('src/reportWebVitals.ts', 'export const reportWebVitals = () => {}'),
      file('src/App.tsx'),
    ])
    expect(matches.map((m) => m.id)).toEqual(['create-react-app'])
  })

  it('NAMES the file it matched on, so a reviewer can check rather than trust', () => {
    const [match] = detectTemplates([
      file('src/reportWebVitals.ts', 'reportWebVitals'),
    ])
    expect(match?.matchedOn).toBe('src/reportWebVitals.ts')
  })

  it('requires the confirming content, not just the path', () => {
    // A hand-written file that happens to sit at a scaffold's path is not a scaffold.
    expect(detectTemplates([
      file('src/setupTests.ts', 'import { beforeAll } from "vitest"'),
    ])).toEqual([])
  })

  it('recognises a generator with no content confirmation required', () => {
    expect(detectTemplates([file('next.config.js', 'module.exports = {}')])
      .map((m) => m.id)).toEqual(['next-starter'])
  })

  it('finds nothing in a repository built by hand', () => {
    expect(detectTemplates([
      file('src/server.ts'), file('src/domain/order.ts'), file('README.md'),
    ])).toEqual([])
  })

  it('every registry entry declares at least one identifying path', () => {
    for (const marker of TEMPLATE_MARKERS) {
      expect(marker.paths.length, `${marker.id} has no identifying path`).toBeGreaterThan(0)
    }
  })
})

describe('what counts as generated', () => {
  it('counts a generator’s own files only when that generator was detected', () => {
    const files = [
      file('manage.py', 'DJANGO_SETTINGS_MODULE'),
      file('app/wsgi.py'),
      file('Program.cs'), // a .NET file in a Django project: not this generator's output
    ]
    const generated = generatedPaths(files, detectTemplates(files))
    expect(generated.has('app/wsgi.py')).toBe(true)
    expect(generated.has('Program.cs')).toBe(false)
  })

  it('does NOT treat a generator’s files as scaffold when the generator is absent', () => {
    // `src/vite-env.d.ts` with no vite.config is somebody's own file.
    const files = [file('src/vite-env.d.ts')]
    expect(generatedPaths(files, detectTemplates(files)).size).toBe(0)
  })

  it('classifies build and packaging files as configuration, not as the team’s work', () => {
    expect(classifyFile(file('package.json'), new Set())).toBe('CONFIG')
    expect(classifyFile(file('tsconfig.json'), new Set())).toBe('CONFIG')
    expect(classifyFile(file('apps/api/package.json'), new Set())).toBe('CONFIG')
    expect(classifyFile(file('src/index.ts'), new Set())).toBe('SUBSTANTIVE')
  })

  it('does not mistake a source file for config because of a similar name', () => {
    expect(classifyFile(file('src/packageJsonReader.ts'), new Set())).toBe('SUBSTANTIVE')
  })
})

describe('boilerplate share', () => {
  it('reports scaffold, config and team-written lines separately', () => {
    const files = [
      file('vite.config.ts', 'defineConfig', 20),
      file('src/vite-env.d.ts', '', 5),
      file('package.json', '{}', 25),
      file('src/domain/pricing.ts', 'logic', 150),
    ]
    const share = boilerplateShare(files, generatedPaths(files, detectTemplates(files)))

    expect(share.scaffoldLines).toBe(5)
    expect(share.substantiveLines).toBe(170) // pricing + vite.config (not a generated file)
    expect(share.substantiveFileCount).toBe(2)
  })

  it('computes the share over analysed lines', () => {
    const files = [file('package.json', '{}', 50), file('src/a.ts', 'x', 50)]
    expect(boilerplateShare(files, new Set()).sharePct).toBe(50)
  })

  it('does not divide by zero on an empty repository', () => {
    const share = boilerplateShare([], new Set())
    expect(share.sharePct).toBe(0)
    expect(share.totalLines).toBe(0)
  })

  it('reports 100% for a repository that is only scaffold and config', () => {
    const files = [file('package.json', '{}', 10), file('src/vite-env.d.ts', '', 5)]
    const share = boilerplateShare(files, new Set(['src/vite-env.d.ts']))
    expect(share.sharePct).toBe(100)
    expect(share.substantiveLines).toBe(0)
  })
})

describe('the prose the reviewer and the model both read', () => {
  it('says which generator was recognised and from which file', () => {
    const summary = describeOriginality(originalitySignals(scan([
      file('manage.py', 'DJANGO_SETTINGS_MODULE', 20),
      file('src/orders.py', 'logic', 200),
    ])))
    expect(summary).toContain('Django startproject')
    expect(summary).toContain('manage.py')
  })

  it('offers the innocent reading when NO generator is recognised', () => {
    const summary = describeOriginality(originalitySignals(scan([file('src/a.ts')])))
    // Not "this was hand-written": the honest statement is that we may simply not know it.
    expect(summary).toMatch(/not one this system has been taught to recognise/)
  })

  it('WARNS that shares describe the sample when the scan was truncated', () => {
    const summary = describeOriginality(
      originalitySignals(scan([file('src/a.ts')], { budgetTruncated: true })))
    expect(summary).toMatch(/did not read the whole repository/)
  })

  it('says history is absent rather than implying concealment', () => {
    const summary = describeOriginality(originalitySignals(scan([file('src/a.ts')])))
    expect(summary).toContain('No readable git history')
    expect(summary).not.toMatch(/suspicious|cheat|plagiar/i)
  })

  it('reports commit counts and the largest-commit share as figures, not verdicts', () => {
    const summary = describeOriginality(originalitySignals(scan([file('src/a.ts')], {
      provenance: {
        firstCommitAt: null, lastCommitAt: null, totalCommits: 12,
        commitsInWindow: 10, commitsOutOfWindow: 2, distinctAuthors: 3,
        authors: [], largestSingleCommitPct: 55, historyTruncated: false,
      },
    })))
    expect(summary).toContain('12 commits')
    expect(summary).toContain('55%')
    expect(summary).not.toMatch(/reused|copied|suspicious/i)
  })

  it('says commit counts are lower bounds when history was truncated', () => {
    const summary = describeOriginality(originalitySignals(scan([file('src/a.ts')], {
      provenance: {
        firstCommitAt: null, lastCommitAt: null, totalCommits: 5,
        commitsInWindow: 5, commitsOutOfWindow: 0, distinctAuthors: 1,
        authors: [], largestSingleCommitPct: 20, historyTruncated: true,
      },
    })))
    expect(summary).toMatch(/lower bounds/)
  })
})
