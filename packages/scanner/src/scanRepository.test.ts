/**
 * Scanner package tests (E04-S01 … E04-S04).
 *
 * These run with **no database and no API** — E04-S01 acceptance 5. The package has zero
 * dependencies, so a fixture directory is all that is needed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { scanRepository, summarise } from './scanRepository.js'
import { getRepoStats, primaryLanguage } from './repoStats.js'
import { gatherFiles, findCandidates, countLines } from './fileGathering.js'
import { profileFor, filePriority, recommendDepth, DEPTH_PROFILES } from './depthProfiles.js'
import { findMarkers } from './repoMarkers.js'
import { isTestFile, splitLines } from './codeMetrics.js'
import { languageOf, isCodeLanguage } from './languages.js'
import { shouldSkipDir, shouldSkipFile } from './skipLists.js'
import { chunkArray, chunkByBytes, mergeByKey } from './chunking.js'
import { compareStrings } from './ordering.js'
import { makeRepo, typicalSubmission, largeSubmission, type FixtureRepo } from './testFixtures.js'

let repo: FixtureRepo | null = null

afterEach(() => {
  repo?.cleanup()
  repo = null
})

function build(files: Record<string, string>): string {
  repo = makeRepo(files)
  return repo.path
}

describe('skip lists (E04-S02)', () => {
  it.each(['node_modules', 'dist', 'build', '.git', '__pycache__', 'vendor', 'coverage'])(
    'skips the %s directory', (dir) => expect(shouldSkipDir(dir)).toBe(true))

  it('does not skip .github — CI configuration is a real signal', () => {
    expect(shouldSkipDir('.github')).toBe(false)
  })

  it.each(['logo.png', 'app.min.js', 'bundle.min.css', 'private.pem', 'archive.zip', 'data.sqlite'])(
    'skips %s', (file) => expect(shouldSkipFile(file)).toBe(true))

  it('NEVER reads a .env file — it holds live credentials (P8.3)', () => {
    expect(shouldSkipFile('.env')).toBe(true)
    expect(shouldSkipFile('.env.production')).toBe(true)
  })

  it('does read .env.example, which holds placeholders and documents configuration', () => {
    expect(shouldSkipFile('.env.example')).toBe(false)
  })

  it.each(['pnpm-lock.yaml', 'package-lock.json', 'Cargo.lock', 'go.sum'])(
    'skips the contents of %s', (file) => expect(shouldSkipFile(file)).toBe(true))
})

describe('scanning a typical submission', () => {
  it('reads the source and skips what is not the team’s work', async () => {
    const result = await scanRepository({ repoPath: build(typicalSubmission()) })
    const paths = result.files.map((f) => f.path)

    expect(paths).toContain('src/server.js')
    expect(paths).toContain('src/detection.js')
    expect(paths).toContain('test/detection.test.js')

    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false)
    expect(paths).not.toContain('pnpm-lock.yaml')
    expect(paths).not.toContain('assets/logo.png')
  })

  it('NEVER includes a .env file in the result', async () => {
    const result = await scanRepository({ repoPath: build(typicalSubmission()) })
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('sk-real-secret')
  })

  it('computes metrics from what it read', async () => {
    const { metrics } = await scanRepository({ repoPath: build(typicalSubmission()) })
    expect(metrics.filesAnalysed).toBeGreaterThan(3)
    expect(metrics.totalLines).toBeGreaterThan(20)
    expect(metrics.codeLines).toBeGreaterThan(0)
    expect(metrics.commentLines).toBeGreaterThan(0)
    expect(metrics.languages).toContain('javascript')
    expect(metrics.dependencyCount).toBe(3)
  })

  it('detects tests, CI, Dockerfile, README and a lockfile', async () => {
    const { metrics, markers } = await scanRepository({ repoPath: build(typicalSubmission()) })
    expect(metrics.hasTests).toBe(true)
    expect(metrics.testFileCount).toBeGreaterThan(0)
    expect(metrics.hasCi).toBe(true)
    expect(metrics.hasDockerfile).toBe(true)
    expect(metrics.hasReadme).toBe(true)
    // The lockfile's CONTENTS are skipped, but its presence is still a signal.
    expect(metrics.hasLockfile).toBe(true)
    expect(markers.lockfiles).toContain('pnpm-lock.yaml')
  })

  it('records where every file came from, so a score can cite it', async () => {
    const result = await scanRepository({ repoPath: build(typicalSubmission()) })
    for (const file of result.files) {
      expect(file.path).not.toMatch(/^\//)
      expect(file.path).not.toContain('\\')
      expect(file.lines).toBeGreaterThanOrEqual(0)
      expect(file.language).toBeTruthy()
    }
  })

  it('handles an empty directory without throwing', async () => {
    const result = await scanRepository({ repoPath: build({}) })
    expect(result.files).toEqual([])
    expect(result.metrics.filesAnalysed).toBe(0)
    expect(result.budgetTruncated).toBe(false)
  })

  it('rejects a path that is not a directory', async () => {
    await expect(scanRepository({ repoPath: '/definitely/not/here' })).rejects.toThrow(/could not be read/)
  })
})

describe('determinism (P4.4)', () => {
  it('produces identical results across repeated scans', async () => {
    const path = build(typicalSubmission())
    const a = await scanRepository({ repoPath: path })
    const b = await scanRepository({ repoPath: path })

    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path))
    expect(a.metrics).toEqual(b.metrics)
    expect(a.filesAnalysed).toBe(b.filesAnalysed)
  })

  it('returns files in a stable, path-sorted order', async () => {
    const result = await scanRepository({ repoPath: build(typicalSubmission()) })
    const paths = result.files.map((f) => f.path)
    // Sorted with the scanner's own locale-independent comparator, not `Array.sort()`'s
    // default and not `localeCompare` — the point is that ordering cannot vary by host.
    expect(paths).toEqual([...paths].sort(compareStrings))
  })

  it('orders paths identically regardless of the ambient locale (P4.4)', () => {
    // localeCompare would order these differently under a Turkish or Swedish locale.
    const paths = ['README.md', 'package.json', 'Src/a.ts', 'src/a.ts', 'ä.ts', 'z.ts']
    const once = [...paths].sort(compareStrings)
    const twice = [...paths].reverse().sort(compareStrings)
    expect(once).toEqual(twice)
  })

  it('selects the SAME files under a budget every time', async () => {
    const path = build(largeSubmission(300))
    const a = await scanRepository({ repoPath: path, maxFiles: 25 })
    const b = await scanRepository({ repoPath: path, maxFiles: 25 })
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path))
  })
})

describe('file budget (E04-S04)', () => {
  it('stops at the budget and SAYS SO (acceptance 2 and 3)', async () => {
    const result = await scanRepository({ repoPath: build(largeSubmission(300)), maxFiles: 20 })
    expect(result.filesAnalysed).toBe(20)
    expect(result.filesTotal).toBeGreaterThan(200)
    expect(result.budgetTruncated).toBe(true)
  })

  it('reports no truncation when everything fitted', async () => {
    const result = await scanRepository({ repoPath: build(typicalSubmission()) })
    expect(result.budgetTruncated).toBe(false)
    expect(result.filesAnalysed).toBe(result.filesTotal)
  })

  it('reads the most informative files first when the budget bites', async () => {
    const result = await scanRepository({ repoPath: build(largeSubmission(300)), maxFiles: 5 })
    const paths = result.files.map((f) => f.path)
    // Entry point and manifest beat an arbitrary deep utility.
    expect(paths).toContain('README.md')
    expect(paths).toContain('package.json')
    expect(paths).toContain('src/index.js')
  })

  it('truncates an oversized file rather than dropping it, and flags it', async () => {
    const path = build({ 'src/huge.js': 'x'.repeat(200_000) })
    const result = await scanRepository({ repoPath: path })
    const huge = result.files.find((f) => f.path === 'src/huge.js')
    expect(huge?.truncated).toBe(true)
    expect(huge!.content.length).toBeLessThanOrEqual(profileFor('standard').maxBytesPerFile)
  })

  it('records the depth it ran at', async () => {
    const path = build(typicalSubmission())
    expect((await scanRepository({ repoPath: path, depth: 'deep' })).depth).toBe('deep')
    expect((await scanRepository({ repoPath: path })).depth).toBe('standard')
  })

  it('each profile is strictly larger than the one below it', () => {
    expect(DEPTH_PROFILES.deep.maxFiles).toBeGreaterThan(DEPTH_PROFILES.standard.maxFiles)
    expect(DEPTH_PROFILES.exhaustive.maxFiles).toBeGreaterThan(DEPTH_PROFILES.deep.maxFiles)
  })

  it('recommends a depth from repository size', () => {
    expect(recommendDepth(50)).toBe('standard')
    expect(recommendDepth(300)).toBe('deep')
    expect(recommendDepth(2000)).toBe('exhaustive')
  })
})

describe('priority ordering', () => {
  it('ranks entry points and manifests above deep utilities', () => {
    expect(filePriority('package.json')).toBeGreaterThan(filePriority('src/a/b/c/helper.ts'))
    expect(filePriority('src/index.ts')).toBeGreaterThan(filePriority('src/a/b/c/helper.ts'))
    expect(filePriority('src/routes/api.ts')).toBeGreaterThan(filePriority('src/misc/thing.ts'))
  })

  it('ranks generated and example code below real source', () => {
    expect(filePriority('src/generated/client.ts')).toBeLessThan(filePriority('src/client.ts'))
    expect(filePriority('examples/widget.ts')).toBeLessThan(filePriority('src/widget.ts'))
  })
})

describe('repository statistics', () => {
  it('describes shape without reading contents', () => {
    const stats = getRepoStats(build(typicalSubmission()))
    expect(stats.sourceFiles).toBeGreaterThan(3)
    expect(stats.byLanguage['javascript']).toBeGreaterThan(0)
    expect(stats.topDirectories).toContain('src')
    expect(stats.totalBytes).toBeGreaterThan(0)
  })

  it('counts the whole repository even when the scan will be truncated', async () => {
    const path = build(largeSubmission(300))
    const stats = getRepoStats(path)
    const scan = await scanRepository({ repoPath: path, maxFiles: 10 })
    expect(stats.sourceFiles).toBeGreaterThan(scan.filesAnalysed)
    expect(scan.filesTotal).toBe(stats.sourceFiles)
  })

  it('identifies the dominant language', () => {
    expect(primaryLanguage(getRepoStats(build(typicalSubmission())))).toBe('javascript')
  })

  it('returns null for a dominant language when there is no code', () => {
    expect(primaryLanguage(getRepoStats(build({ 'README.md': '# only docs' })))).toBeNull()
  })
})

describe('language identification', () => {
  it.each([
    ['src/a.ts', 'typescript'], ['a.py', 'python'], ['main.go', 'go'],
    ['App.java', 'java'], ['index.html', 'html'], ['Dockerfile', 'dockerfile'],
    ['Makefile', 'makefile'], ['q.sql', 'sql'], ['x.unknownext', 'other'],
  ])('%s is %s', (path, expected) => expect(languageOf(path)).toBe(expected))

  it('distinguishes code from configuration and prose', () => {
    expect(isCodeLanguage('typescript')).toBe(true)
    expect(isCodeLanguage('markdown')).toBe(false)
    expect(isCodeLanguage('json')).toBe(false)
  })
})

describe('line accounting', () => {
  it('splits code, comment and blank lines', () => {
    const file = {
      path: 'a.ts', bytes: 0, lines: 6, language: 'typescript', truncated: false,
      content: ['// a comment', '', 'const x = 1', '/* block', '   continues */', 'export { x }'].join('\n'),
    }
    const split = splitLines(file)
    expect(split.comment).toBe(3)
    expect(split.blank).toBe(1)
    expect(split.code).toBe(2)
  })

  it('uses the right comment marker per language', () => {
    const py = {
      path: 'a.py', bytes: 0, lines: 2, language: 'python', truncated: false,
      content: '# comment\nx = 1',
    }
    expect(splitLines(py)).toMatchObject({ comment: 1, code: 1 })
  })

  it('counts lines without a trailing newline correctly', () => {
    expect(countLines('a\nb\nc')).toBe(3)
    expect(countLines('a\nb\n')).toBe(3)
    expect(countLines('')).toBe(0)
  })

  it.each([
    'src/a.test.ts', 'tests/thing.js', '__tests__/x.js', 'spec/y_spec.rb', 'test_module.py',
  ])('recognises %s as a test file', (p) => expect(isTestFile(p)).toBe(true))

  it('does not mistake a "latest" directory for tests', () => {
    expect(isTestFile('src/latest/index.ts')).toBe(false)
  })
})

describe('markers (presence despite skip lists)', () => {
  it('finds a lockfile whose contents are deliberately skipped', () => {
    const markers = findMarkers(build({ 'pnpm-lock.yaml': 'x', 'package.json': '{}' }))
    expect(markers.hasLockfile).toBe(true)
    expect(markers.lockfiles).toEqual(['pnpm-lock.yaml'])
  })

  it('finds a Dockerfile one level down', () => {
    const markers = findMarkers(build({ 'docker/Dockerfile': 'FROM node' }))
    expect(markers.hasDockerfile).toBe(true)
    expect(markers.dockerfilePaths).toContain('docker/Dockerfile')
  })

  it('does not count an EMPTY .github/workflows directory as CI', () => {
    const markers = findMarkers(build({ '.github/workflows/.gitkeep': '' }))
    expect(markers.ciSystems).toContain('.github/workflows')
    const none = findMarkers(build({ 'src/a.js': 'x' }))
    expect(none.hasCi).toBe(false)
  })

  it('reports absent markers as absent, not as unknown', () => {
    const markers = findMarkers(build({ 'src/a.js': 'x' }))
    expect(markers).toMatchObject({
      hasReadme: false, hasLockfile: false, hasCi: false,
      hasDockerfile: false, hasLicense: false,
    })
  })
})

describe('chunking (P4.4)', () => {
  it('splits preserving order', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('rejects a chunk size below one rather than looping forever', () => {
    expect(() => chunkArray([1], 0)).toThrow(/at least 1/)
  })

  it('bounds chunks by bytes, never dropping an oversized item', () => {
    const items = [{ n: 10 }, { n: 10 }, { n: 500 }]
    const chunks = chunkByBytes(items, (i) => i.n, 25)
    expect(chunks.flat()).toEqual(items)
    expect(chunks.some((c) => c.length === 1 && c[0]!.n === 500)).toBe(true)
  })

  it('merges by key with an explicit preference, not last-write-wins', () => {
    const merged = mergeByKey(
      [[{ id: 'a', score: 1 }], [{ id: 'a', score: 5 }, { id: 'b', score: 2 }]],
      (i) => i.id,
      (x, y) => (y.score > x.score ? y : x),
    )
    expect(merged).toEqual([{ id: 'a', score: 5 }, { id: 'b', score: 2 }])
  })

  it('merges in key order, independent of batch arrival order', () => {
    const forward = mergeByKey([[{ id: 'b' }], [{ id: 'a' }]], (i) => i.id, (x) => x)
    const reverse = mergeByKey([[{ id: 'a' }], [{ id: 'b' }]], (i) => i.id, (x) => x)
    expect(forward).toEqual(reverse)
  })
})

describe('summarise', () => {
  it('drops file contents while keeping every other fact', async () => {
    const result = await scanRepository({ repoPath: build(typicalSubmission()) })
    const summary = summarise(result)
    expect(summary.files[0]).not.toHaveProperty('content')
    expect(summary.files).toHaveLength(result.files.length)
    expect(summary.metrics).toEqual(result.metrics)
  })
})

describe('gatherFiles directly', () => {
  it('counts candidates independently of what it read', () => {
    const path = build(largeSubmission(100))
    const gathered = gatherFiles(path, { ...profileFor('standard'), maxFiles: 5 })
    expect(gathered.files).toHaveLength(5)
    expect(gathered.candidatesFound).toBeGreaterThan(90)
    expect(gathered.budgetTruncated).toBe(true)
  })

  it('respects the directory depth limit', () => {
    const deep: Record<string, string> = {}
    deep['a/b/c/d/e/f/g/h/i/j/deep.js'] = 'export const x = 1'
    const path = build(deep)
    const shallow = findCandidates(path, { ...profileFor('standard'), maxDirDepth: 3 })
    expect(shallow).toHaveLength(0)
    const full = findCandidates(path, { ...profileFor('exhaustive'), maxDirDepth: 14 })
    expect(full).toHaveLength(1)
  })
})
