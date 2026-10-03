/**
 * Context builder tests (E06-S01) — the single largest quality lever in the system.
 *
 * The property under test is that a criterion is shown the code it is actually about. A builder
 * that returns plausible-looking context for every criterion would make every score look
 * defensible and be worthless.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { scanRepository, makeRepo, type FixtureRepo, type ScanResult } from '@crucible/scanner'
import type { Criterion } from '@crucible/rubric'
import { buildContext, DEFAULT_CONTEXT_OPTIONS } from './contextBuilder.js'
import { extractTerms, rankFiles, scoreFile } from './relevance.js'

let repo: FixtureRepo | null = null
afterEach(() => { repo?.cleanup(); repo = null })

const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }

function criterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    criterionId: 'c1',
    dimension: 'CHALLENGE_FIDELITY',
    name: 'Validates external input',
    description: 'Whether data arriving from outside is checked before use.',
    weight: 1,
    evidenceSpec: 'A reader can point to validation applied to external input before storage.',
    anchors,
    sortOrder: 0,
    ...overrides,
  }
}

/** A submission with clearly separated concerns, so selection can be checked. */
const SUBMISSION: Record<string, string> = {
  'src/validation.js': [
    "import { z } from 'zod'",
    '',
    'const recordSchema = z.object({ value: z.number(), at: z.string() })',
    '',
    'export function validateInput(payload) {',
    '  // Reject anything that does not match the documented schema.',
    '  const parsed = recordSchema.safeParse(payload)',
    '  if (!parsed.success) throw new Error("invalid record")',
    '  return parsed.data',
    '}',
  ].join('\n'),
  'src/alerting.js': [
    'export async function raiseAlert(breach) {',
    '  await fetch(process.env.ALERT_WEBHOOK, {',
    '    method: "POST",',
    '    body: JSON.stringify(breach),',
    '  })',
    '}',
  ].join('\n'),
  'src/storage.js': [
    'export async function persist(record) {',
    '  return db.insert("records", record)',
    '}',
  ].join('\n'),
  'README.md': '# Telemetry\n\nThis project validates input and raises alerts.\n',
  'package.json': '{"name":"telemetry","dependencies":{"zod":"^3.0.0"}}',
}

async function scanOf(files: Record<string, string>): Promise<ScanResult> {
  repo = makeRepo(files)
  return scanRepository({ repoPath: repo.path })
}

describe('term extraction', () => {
  it('pulls the concepts out of an evidence specification', () => {
    const terms = extractTerms('A reader can point to validation applied to external input.')
    expect(terms).toContain('validation')
    expect(terms).toContain('external')
    expect(terms).toContain('input')
  })

  it('drops words that cannot discriminate between files', () => {
    const terms = extractTerms('A reader can point to the code in the repository')
    expect(terms).not.toContain('reader')
    expect(terms).not.toContain('code')
    expect(terms).not.toContain('repository')
    expect(terms).not.toContain('the')
  })

  it('splits camelCase so an evidence spec matches identifiers', () => {
    expect(extractTerms('validateInput handler')).toEqual(
      expect.arrayContaining(['validate', 'input', 'handler']))
  })

  it('stems plurals and inflections, so "validates" matches "validation"', () => {
    const terms = extractTerms('validates inputs')
    expect(terms).toContain('validate')
    expect(terms).toContain('input')
  })
})

describe('file relevance', () => {
  it('ranks distinct term coverage above repetition', () => {
    const terms = ['validate', 'schema', 'input']
    const broad = scoreFile('a.js', 'validate schema input', terms)
    const repetitive = scoreFile('b.js', 'input input input input input input', terms)
    expect(broad.score).toBeGreaterThan(repetitive.score)
  })

  it('rewards a path that names the concept', () => {
    const terms = ['validation']
    const named = scoreFile('src/validation.js', 'const x = 1', terms)
    const unnamed = scoreFile('src/misc.js', 'const x = 1', terms)
    expect(named.score).toBeGreaterThan(unnamed.score)
  })

  it('ranks documentation below implementation — prose cannot demonstrate a claim', () => {
    const terms = ['validation', 'input']
    const code = scoreFile('src/v.js', 'validation of input', terms)
    const docs = scoreFile('README.md', 'validation of input', terms)
    expect(docs.score).toBeLessThan(code.score)
  })

  it('ranks tests below implementation, but still considers them', () => {
    const terms = ['validation']
    const impl = scoreFile('src/v.js', 'validation here', terms)
    const test = scoreFile('src/v.test.js', 'validation here', terms)
    expect(test.score).toBeLessThan(impl.score)
    expect(test.score).toBeGreaterThan(0)
  })

  it('is deterministic, including tie-breaking (P4.4)', () => {
    const files = [
      { path: 'b.js', content: 'validate' },
      { path: 'a.js', content: 'validate' },
    ]
    const once = rankFiles(files, ['validate']).map((f) => f.path)
    const twice = rankFiles([...files].reverse(), ['validate']).map((f) => f.path)
    expect(once).toEqual(twice)
    expect(once[0]).toBe('a.js')
  })
})

describe('selection is driven by the evidence spec (acceptance 2)', () => {
  it('selects the validation file for a validation criterion', async () => {
    const context = buildContext(criterion(), await scanOf(SUBMISSION))
    const paths = context.excerpts.map((e) => e.path)
    expect(paths).toContain('src/validation.js')
  })

  it('selects DIFFERENT files for a different criterion — not a fixed list', async () => {
    const scan = await scanOf(SUBMISSION)

    const validation = buildContext(criterion(), scan)
    const alerting = buildContext(criterion({
      criterionId: 'c2',
      name: 'Raises an alert through the required channel',
      description: 'Whether a detected breach dispatches an alert.',
      evidenceSpec: 'A reader can point to the code that dispatches an alert to the webhook channel.',
    }), scan)

    expect(validation.excerpts.map((e) => e.path)).toContain('src/validation.js')
    expect(alerting.excerpts.map((e) => e.path)).toContain('src/alerting.js')
    // The two criteria must not receive identical context — that was finding F3's failure.
    expect(validation.excerpts.map((e) => e.path))
      .not.toEqual(alerting.excerpts.map((e) => e.path))
  })

  it('ranks the most relevant file first', async () => {
    const context = buildContext(criterion(), await scanOf(SUBMISSION))
    const topPath = [...context.excerpts].sort((a, b) => b.relevance - a.relevance)[0]?.path
    expect(topPath).toBe('src/validation.js')
  })
})

describe('excerpts carry locations (acceptance 1)', () => {
  it('gives every excerpt a path and a real line range', async () => {
    const context = buildContext(criterion(), await scanOf(SUBMISSION))
    for (const excerpt of context.excerpts) {
      expect(excerpt.path).toBeTruthy()
      expect(excerpt.lineStart).toBeGreaterThanOrEqual(1)
      expect(excerpt.lineEnd).toBeGreaterThanOrEqual(excerpt.lineStart)
      expect(excerpt.text.length).toBeGreaterThan(0)
    }
  })

  it('reports line numbers that actually locate the quoted text', async () => {
    const scan = await scanOf(SUBMISSION)
    const context = buildContext(criterion(), scan)
    const excerpt = context.excerpts.find((e) => e.path === 'src/validation.js')!
    const fileLines = (scan.files.find((f) => f.path === 'src/validation.js')!).content.split('\n')

    // The excerpt must be exactly the lines it claims — an appeal will check this.
    expect(excerpt.text).toBe(
      fileLines.slice(excerpt.lineStart - 1, excerpt.lineEnd).join('\n'))
  })

  it('says why each excerpt was chosen', async () => {
    const context = buildContext(criterion(), await scanOf(SUBMISSION))
    expect(context.excerpts[0]?.reason).toMatch(/Mentions/)
  })

  it('merges overlapping windows rather than repeating lines', async () => {
    const scan = await scanOf({
      'src/validate.js': Array.from({ length: 40 },
        (_, i) => `// line ${i} mentions validation and input`).join('\n'),
    })
    const context = buildContext(criterion(), scan)
    const forFile = context.excerpts.filter((e) => e.path === 'src/validate.js')
    // Every matching line with a ±12 window collapses into one contiguous excerpt.
    expect(forFile).toHaveLength(1)
  })
})

describe('budget is explicit and recorded (acceptance 3)', () => {
  it('records how much of the budget was used', async () => {
    const context = buildContext(criterion(), await scanOf(SUBMISSION))
    expect(context.budgetLimitBytes).toBe(DEFAULT_CONTEXT_OPTIONS.budgetBytes)
    expect(context.budgetUsedBytes).toBeGreaterThan(0)
    expect(context.budgetUsedBytes).toBeLessThanOrEqual(context.budgetLimitBytes)
  })

  it('stops at the budget and SAYS it truncated', async () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 40; i++) {
      big[`src/validator-${i}.js`] =
        Array.from({ length: 80 }, () => 'validate input against the schema before storage').join('\n')
    }
    const context = buildContext(criterion(), await scanOf(big), {
      ...DEFAULT_CONTEXT_OPTIONS, budgetBytes: 4_000,
    })
    expect(context.budgetUsedBytes).toBeLessThanOrEqual(4_000)
    expect(context.budgetTruncated).toBe(true)
  })

  it('records how many files were searched', async () => {
    const scan = await scanOf(SUBMISSION)
    expect(buildContext(criterion(), scan).filesSearched).toBe(scan.files.length)
  })
})

describe('insufficient evidence is NOT a low score (acceptance 4)', () => {
  it('reports insufficient evidence when nothing relates to the criterion', async () => {
    const scan = await scanOf({
      'src/colours.js': 'export const palette = ["red", "green", "blue"]\n',
      'README.md': '# A palette library\n',
    })
    const context = buildContext(criterion({
      name: 'Implements the Kalman filter described in the brief',
      description: 'Whether the state estimator from the brief is implemented.',
      evidenceSpec: 'A reader can point to a Kalman filter implementation and its covariance update.',
    }), scan)

    expect(context.insufficientEvidence).toBe(true)
    expect(context.excerpts).toEqual([])
    // Crucially: no score is implied. The caller must record INSUFFICIENT_EVIDENCE, not 0.
    expect(context.insufficientReason).toBeTruthy()
  })

  it('names the terms it searched for, so a reviewer can judge the search', async () => {
    const scan = await scanOf({ 'src/a.js': 'export const a = 1\n' })
    const context = buildContext(criterion({
      evidenceSpec: 'A reader can point to the telemetry ingestion pipeline.',
    }), scan)
    expect(context.insufficientReason).toMatch(/searched for:/)
    expect(context.insufficientReason).toMatch(/telemetry|ingestion|pipeline/)
  })

  it('warns that a truncated scan may be the reason, rather than absence', async () => {
    const big: Record<string, string> = { 'README.md': '# Big project\n' }
    for (let i = 0; i < 300; i++) big[`src/mod-${i}/index.js`] = `export const m${i} = ${i}\n`

    repo = makeRepo(big)
    const scan = await scanRepository({ repoPath: repo.path, maxFiles: 10 })
    const context = buildContext(criterion({
      evidenceSpec: 'A reader can point to the telemetry ingestion pipeline.',
    }), scan)

    expect(context.insufficientEvidence).toBe(true)
    // The honest caveat: we may simply not have read the relevant file.
    expect(context.insufficientReason).toMatch(/may not have been read at all/)
  })

  it('states plainly when the WHOLE repository was read and the code is absent', async () => {
    const scan = await scanOf({ 'src/a.js': 'export const a = 1\n' })
    const context = buildContext(criterion({
      evidenceSpec: 'A reader can point to the telemetry ingestion pipeline.',
    }), scan)
    expect(context.insufficientReason).toMatch(/whole repository was read/)
  })

  it('cites the brief reference for a fidelity criterion', async () => {
    const scan = await scanOf({ 'src/a.js': 'export const a = 1\n' })
    const context = buildContext(criterion({
      evidenceSpec: 'A reader can point to the telemetry ingestion pipeline.',
      sourceRef: 'brief §2.1',
    }), scan)
    expect(context.insufficientReason).toContain('brief §2.1')
  })
})

describe('repository summary', () => {
  it('states facts the model should not have to infer from excerpts', async () => {
    const context = buildContext(criterion(), await scanOf(SUBMISSION))
    expect(context.repoSummary).toMatch(/Languages:/)
    expect(context.repoSummary).toMatch(/lines of code|lines total/)
    expect(context.repoSummary).toMatch(/Tests:/)
  })

  it('states when the scan itself was truncated', async () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 100; i++) big[`src/f${i}.js`] = 'validate input\n'
    repo = makeRepo(big)
    const scan = await scanRepository({ repoPath: repo.path, maxFiles: 5 })
    expect(buildContext(criterion(), scan).repoSummary).toMatch(/file budget truncated/)
  })
})

describe('determinism (P4.4)', () => {
  it('builds identical context for the same criterion and scan', async () => {
    const scan = await scanOf(SUBMISSION)
    expect(buildContext(criterion(), scan)).toEqual(buildContext(criterion(), scan))
  })
})
