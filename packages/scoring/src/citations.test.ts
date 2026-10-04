/**
 * Citation verification (E13-S01, P4.1 clause 3).
 *
 * The property under test is the one the whole system's defensibility rests on: a citation that
 * cannot be traced to the commit the team submitted must not pass as one that can. And the
 * inverse, which matters just as much — a citation we simply could not check must not be
 * mistaken for a fabricated one.
 */
import { describe, expect, it } from 'vitest'
import type { ScanResult, ScannedFile } from '@crucible/scanner'
import {
  describeCitations, elisionSegments, matchesWithElision,
  normaliseExcerpt, verifyCitation, verifyCitations,
} from './citations.js'

function file(path: string, content: string, truncated = false): ScannedFile {
  return {
    path, content, language: 'typescript',
    bytes: content.length, lines: content.split('\n').length, truncated,
  }
}

function scan(files: ScannedFile[], overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    commitSha: 'a'.repeat(40), headCommittedAt: null, depth: 'standard',
    files,
    stats: {
      totalFiles: files.length, sourceFiles: files.length,
      totalBytes: 0, byLanguage: {}, topDirectories: [], recommendedDepth: 'standard',
    },
    metrics: {
      filesAnalysed: files.length, totalLines: 0, codeLines: 0, commentLines: 0,
      blankLines: 0, languages: [], longFiles: [], maxFileLines: 0, averageFileLines: 0,
      hasTests: false, testFileCount: 0, hasCi: false, hasDockerfile: false,
      hasReadme: false, hasLockfile: false, dependencyCount: 0,
    },
    markers: {} as ScanResult['markers'],
    provenance: null,
    filesAnalysed: files.length, filesTotal: files.length, budgetTruncated: false,
    scannedAt: '2026-01-01T00:00:00Z', durationMs: 1,
    ...overrides,
  }
}

const SOURCE = [
  'import { requireAuth } from "./auth.js"',      // 1
  '',                                              // 2
  'export function registerRoutes(app) {',         // 3
  '  app.get("/api/teams", requireAuth, list)',    // 4
  '  app.post("/api/teams", requireAuth, create)', // 5
  '}',                                             // 6
].join('\n')

const REPO = scan([file('src/routes/teams.ts', SOURCE)])

/** The same repository, read only in part — so an absent file may genuinely exist unread. */
const PARTIAL = scan([file('src/routes/teams.ts', SOURCE)], {
  budgetTruncated: true, filesAnalysed: 1, filesTotal: 40,
})

const cite = (over: Partial<Parameters<typeof verifyCitation>[0]> = {}) => ({
  path: 'src/routes/teams.ts', lineStart: 4, lineEnd: 5,
  excerpt: 'app.get("/api/teams", requireAuth, list)', ...over,
})

describe('a citation that holds', () => {
  it('verifies when the file, the range and the quoted text all check out', () => {
    expect(verifyCitation(cite(), REPO).verdict).toBe('VERIFIED')
  })

  it('tolerates a leading ./ on the path — a formatting habit, not a different file', () => {
    expect(verifyCitation(cite({ path: './src/routes/teams.ts' }), REPO).verdict).toBe('VERIFIED')
  })

  it('tolerates a small line drift, because an off-by-two is a nuisance not a fabrication', () => {
    expect(verifyCitation(cite({ lineStart: 6, lineEnd: 7 }), REPO).verdict).toBe('VERIFIED')
  })

  it('tolerates a trimmed quote with an ellipsis', () => {
    expect(verifyCitation(cite({ excerpt: 'app.get("/api/teams", ... list)' }), REPO).verdict)
      .toBe('VERIFIED')
  })

  it('tolerates re-indentation and collapsed whitespace', () => {
    expect(verifyCitation(cite({ excerpt: '  app.get("/api/teams",   requireAuth, list)  ' }), REPO)
      .verdict).toBe('VERIFIED')
  })

  it('verifies a range-only citation, because an empty quote claims nothing to contradict', () => {
    expect(verifyCitation(cite({ excerpt: '' }), REPO).verdict).toBe('VERIFIED')
  })

  it('verifies when no line was given but the text is in the file', () => {
    expect(verifyCitation(cite({ lineStart: null, lineEnd: null }), REPO).verdict).toBe('VERIFIED')
  })
})

describe('a citation that is contradicted', () => {
  it('rejects a quote that appears nowhere in the file', () => {
    const check = verifyCitation(cite({ excerpt: 'app.delete("/api/teams", purge)' }), REPO)
    expect(check.verdict).toBe('CONTRADICTED')
    expect(check.reason).toMatch(/does not appear/i)
  })

  it('rejects a line beyond the end of the file when nothing was quoted', () => {
    // With no excerpt the range is the entire claim, so it has to hold on its own.
    const check = verifyCitation(cite({ lineStart: 400, lineEnd: 410, excerpt: '' }), REPO)
    expect(check.verdict).toBe('CONTRADICTED')
    expect(check.reason).toMatch(/has 6 lines/)
  })

  it('rejects a line beyond the end AND an invented quote, naming both faults', () => {
    const check = verifyCitation(
      cite({ lineStart: 400, lineEnd: 410, excerpt: 'app.delete("/api/teams", purge)' }), REPO)
    expect(check.verdict).toBe('CONTRADICTED')
    expect(check.reason).toMatch(/does not appear/i)
    expect(check.reason).toMatch(/has 6 lines/)
  })

  it('RELOCATES a real quote cited beyond the end of the file', () => {
    // The same wrong arithmetic as any other misplaced line, so it gets the same treatment.
    const check = verifyCitation(cite({ lineStart: 400, lineEnd: 410 }), REPO)
    expect(check.verdict).toBe('RELOCATED')
    expect(check.corrected).toEqual({ lineStart: 4, lineEnd: 4 })
  })

  it('RELOCATES a quote that exists but far from where it was cited, and says where', () => {
    // Nothing was invented: the quotation is exact and the file is right, only the line number
    // is wrong. Rejecting it threw away the whole response, retried it three times, and then
    // lost the criterion — which RAISED the entry's score, because the composite renormalises
    // over covered weight. Measured on the calibration set this was 301 of 344 rejections.
    const long = scan([file('src/big.ts', [...Array(60).fill('// filler'), 'const KEY = 1'].join('\n'))])
    const check = verifyCitation(
      { path: 'src/big.ts', lineStart: 2, lineEnd: 3, excerpt: 'const KEY = 1' }, long)

    expect(check.verdict).toBe('RELOCATED')
    // The corrected range is the point: a reviewer following it must land on the real code.
    expect(check.corrected).toEqual({ lineStart: 61, lineEnd: 61 })
    expect(check.reason).toMatch(/src\/big\.ts:61/)
    expect(check.reason).toMatch(/not the cited 2–3/)
  })

  it('does NOT treat a relocation as fabrication', () => {
    // The distinction the whole change turns on. `anyContradicted` fails an entire response, and
    // the justification for being that strict is that something was made up.
    const long = scan([file('src/big.ts', [...Array(60).fill('// filler'), 'const KEY = 1'].join('\n'))])
    const summary = verifyCitations(
      [{ path: 'src/big.ts', lineStart: 2, lineEnd: 3, excerpt: 'const KEY = 1' }], long)

    expect(summary.anyContradicted).toBe(false)
    expect(summary.relocated).toBe(1)
    expect(summary.contradicted).toBe(0)
  })

  it('still contradicts a quote that is in NO file, however the lines are given', () => {
    // The 42 of 344 that were real fabrications must keep failing.
    const long = scan([file('src/big.ts', 'const KEY = 1')])
    const check = verifyCitation(
      { path: 'src/big.ts', lineStart: 1, lineEnd: 1, excerpt: 'const INVENTED = 99' }, long)
    expect(check.verdict).toBe('CONTRADICTED')
  })

  it('finds the FIRST occurrence when a quote appears twice', () => {
    // Ambiguity resolved the honest way: reporting both would make a reviewer adjudicate our
    // search instead of reading the team's code.
    const twice = scan([file('src/dup.ts', ['const A = 1', '// mid', 'const A = 1'].join('\n'))])
    const check = verifyCitation(
      { path: 'src/dup.ts', lineStart: 90, lineEnd: 91, excerpt: 'const A = 1' }, twice)
    expect(check.verdict).toBe('RELOCATED')
    expect(check.corrected?.lineStart).toBe(1)
  })

  it('relocates a quote that spans several lines, reporting the whole span', () => {
    const multi = scan([file('src/m.ts', [
      '// one', '// two', 'function f() {', '  return 1', '}',
    ].join('\n'))])
    const check = verifyCitation(
      { path: 'src/m.ts', lineStart: 40, lineEnd: 42, excerpt: 'function f() { return 1 }' }, multi)
    expect(check.verdict).toBe('RELOCATED')
    expect(check.corrected).toEqual({ lineStart: 3, lineEnd: 5 })
  })

  it('rejects a file absent from a COMPLETE scan — it does not exist', () => {
    // The distinction that closes the evasion: if the scan read the whole repository, a path
    // it does not hold is a path that is not there. Without this a model could dodge checking
    // entirely by citing only files outside the scan.
    const check = verifyCitation(cite({ path: 'src/never/written.ts' }), REPO)
    expect(check.verdict).toBe('CONTRADICTED')
    expect(check.reason).toMatch(/is not in the repository/i)
  })

  it('is case-sensitive, because User and user are different identifiers', () => {
    expect(verifyCitation(cite({ excerpt: 'APP.GET("/API/TEAMS", REQUIREAUTH, LIST)' }), REPO)
      .verdict).toBe('CONTRADICTED')
  })
})

describe('a citation that cannot be checked', () => {
  it('reports a file absent from a TRUNCATED scan as unverifiable, not as contradicted', () => {
    // The file budget legitimately stops short. Calling this fabrication would punish a team
    // for a limit we imposed.
    const truncatedScan = scan([file('src/routes/teams.ts', SOURCE)], {
      budgetTruncated: true, filesAnalysed: 12,
    })
    const check = verifyCitation(cite({ path: 'src/never/read.ts' }), truncatedScan)
    expect(check.verdict).toBe('UNVERIFIABLE')
    expect(check.reason).toMatch(/may exist unread/i)
  })

  it('reports a line beyond a TRUNCATED file as unverifiable when nothing was quoted', () => {
    const cut = scan([file('src/routes/teams.ts', SOURCE, true)])
    const check = verifyCitation(cite({ lineStart: 400, lineEnd: 402, excerpt: '' }), cut)
    expect(check.verdict).toBe('UNVERIFIABLE')
    expect(check.reason).toMatch(/never read/i)
  })

  it('relocates rather than guesses when the quote IS in the part that was read', () => {
    // Truncation is only an innocent explanation for text we could not find. Here we found it,
    // so there is nothing to be uncertain about.
    const cut = scan([file('src/routes/teams.ts', SOURCE, true)])
    const check = verifyCitation(cite({ lineStart: 400, lineEnd: 402 }), cut)
    expect(check.verdict).toBe('RELOCATED')
    expect(check.corrected).toEqual({ lineStart: 4, lineEnd: 4 })
  })

  it('reports a missing quote in a TRUNCATED file as unverifiable', () => {
    const cut = scan([file('src/routes/teams.ts', SOURCE, true)])
    expect(verifyCitation(cite({ excerpt: 'something further down' }), cut).verdict)
      .toBe('UNVERIFIABLE')
  })
})

describe('summarising a set', () => {
  it('counts each verdict and flags any contradiction', () => {
    const summary = verifyCitations([
      cite(),
      cite({ path: 'src/absent.ts' }),
      cite({ excerpt: 'never written' }),
    ], PARTIAL)

    expect(summary.verified).toBe(1)
    expect(summary.unverifiable).toBe(1)
    expect(summary.contradicted).toBe(1)
    expect(summary.anyContradicted).toBe(true)
  })

  it('does not flag a set whose only failures are unverifiable', () => {
    const summary = verifyCitations([cite(), cite({ path: 'src/absent.ts' })], PARTIAL)
    expect(summary.anyContradicted).toBe(false)
  })

  it('handles an empty set without inventing a verdict', () => {
    const summary = verifyCitations([], REPO)
    expect(summary.checks).toEqual([])
    expect(summary.anyContradicted).toBe(false)
  })
})

describe('describing a set for a reviewer', () => {
  it('leads with what was checked', () => {
    expect(describeCitations(verifyCitations([cite()], REPO)))
      .toMatch(/^1 of 1 citations checked against the scan/)
  })

  it('words an unverifiable citation as a statement about our reading', () => {
    const text = describeCitations(verifyCitations([cite({ path: 'src/absent.ts' })], PARTIAL))
    expect(text).toMatch(/outside what the scan read/i)
    // Never as doubt about the team.
    expect(text).not.toMatch(/fabricat|invent|false|wrong/i)
  })

  it('says plainly when something did not match', () => {
    expect(describeCitations(verifyCitations([cite({ excerpt: 'nope' })], REPO)))
      .toMatch(/did not match the source/i)
  })

  it('says nothing was cited rather than reporting zero of zero', () => {
    expect(describeCitations(verifyCitations([], REPO))).toBe('No evidence was cited.')
  })
})

describe('normalisation', () => {
  it('collapses whitespace without folding case', () => {
    expect(normaliseExcerpt('  const   User = 1\n')).toBe('const User = 1')
  })

  it('drops both ellipsis forms', () => {
    expect(normaliseExcerpt('a ... b … c')).toBe('a b c')
  })
})

describe('elision', () => {
  it('splits a quote on both ellipsis forms', () => {
    expect(elisionSegments('alpha ... beta \u2026 gamma')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('drops empty segments from a leading or trailing marker', () => {
    expect(elisionSegments('... middle ...')).toEqual(['middle'])
  })

  it('treats a quote of nothing but ellipsis as claiming nothing', () => {
    expect(elisionSegments('...')).toEqual([])
    expect(matchesWithElision('anything', '...')).toBe(true)
  })

  it('matches segments across a gap', () => {
    expect(matchesWithElision('const a = compute(x, y, z)', 'const a = ... z)')).toBe(true)
  })

  it('requires segments IN ORDER, so fragments cannot be stitched', () => {
    // Without ordering, a model could quote two unrelated fragments of a file and have the
    // result pass as one contiguous citation.
    expect(matchesWithElision('alpha beta gamma', 'alpha ... gamma')).toBe(true)
    expect(matchesWithElision('alpha beta gamma', 'gamma ... alpha')).toBe(false)
  })

  it('does not let a segment match by overlapping the previous one', () => {
    expect(matchesWithElision('abcabc', 'abcabc ... abcabc')).toBe(false)
  })

  it('rejects when any segment is absent', () => {
    expect(matchesWithElision('alpha beta', 'alpha ... delta')).toBe(false)
  })
})
