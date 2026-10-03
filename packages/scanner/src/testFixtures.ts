/**
 * Fixture repository builder for the scanner's own tests.
 *
 * Builds real directory trees rather than mocking `fs`: the behaviour under test *is*
 * filesystem behaviour — skip lists, directory depth, budget truncation, ordering — and a mock
 * would only assert that the mock behaves like the mock.
 *
 * Exported from the package because the API's integration tests use it too.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FixtureRepo {
  path: string
  cleanup: () => void
}

/** Create a temporary repository from a path → content map. */
export function makeRepo(files: Record<string, string>): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'crucible-fixture-'))

  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  return {
    path: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** A plausible small submission: source, tests, manifest, CI, Dockerfile, README. */
export function typicalSubmission(): Record<string, string> {
  return {
    'README.md': '# Telemetry Triage\n\nConsumes a feed and raises alerts.\n',
    'package.json': JSON.stringify({
      name: 'telemetry-triage',
      dependencies: { express: '^4.18.0', pg: '^8.11.0' },
      devDependencies: { vitest: '^1.0.0' },
    }, null, 2),
    'Dockerfile': 'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "src/server.js"]\n',
    '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
    'src/server.js': [
      '// Entry point',
      "import express from 'express'",
      "import { detectBreach } from './detection.js'",
      '',
      'const app = express()',
      '',
      "app.post('/telemetry', (req, res) => {",
      '  const breach = detectBreach(req.body)',
      '  res.json({ breach })',
      '})',
      '',
      'app.listen(3000)',
    ].join('\n'),
    'src/detection.js': [
      '/* Threshold detection */',
      'const THRESHOLD = 90',
      '',
      'export function detectBreach(record) {',
      '  if (!record) return false',
      '  return record.value > THRESHOLD',
      '}',
    ].join('\n'),
    'src/feed/client.js': "export async function connect() { return { ok: true } }\n",
    'test/detection.test.js': [
      "import { detectBreach } from '../src/detection.js'",
      '',
      "it('detects a breach', () => {",
      '  expect(detectBreach({ value: 99 })).toBe(true)',
      '})',
    ].join('\n'),
    'pnpm-lock.yaml': `lockfileVersion: '9.0'\n${'# generated\n'.repeat(400)}`,
    'node_modules/express/index.js': 'module.exports = function express() {}\n',
    'node_modules/express/package.json': '{"name":"express"}\n',
    'dist/bundle.min.js': 'var a=1;'.repeat(500),
    'assets/logo.png': '\u0000PNG fake binary content',
    '.env': 'DATABASE_URL=postgres://user:hunter2@host/db\nAPI_KEY=sk-real-secret\n',
  }
}

/** A repository large enough to exceed a small file budget. */
export function largeSubmission(fileCount: number): Record<string, string> {
  const files: Record<string, string> = {
    'README.md': '# Large project\n',
    'package.json': '{"name":"large"}',
    'src/index.js': "export const main = () => 'entry'\n",
  }
  for (let i = 0; i < fileCount; i++) {
    files[`src/modules/module-${String(i).padStart(4, '0')}/util.js`] =
      `export function util${i}() {\n  return ${i}\n}\n`
  }
  return files
}
