#!/usr/bin/env node
/**
 * P1.4 — hard file-size limits, for file types ESLint does not lint (SQL migrations) and as a
 * belt-and-braces sweep over the whole tree.
 *
 * Derives every limit from file-size-limits.json — the single declaration (P1.5 clause 6).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { limitFor, loadLimits } from './lib/limits.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const LIMITS = loadLimits()

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'playwright-report',
  'test-results', '.tmp', 'docs', '.pnpm-store',
])

const SCAN_EXT = /\.(ts|tsx|sql)$/

const violations = []

function walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    const rel = relative(ROOT, abs).split('\\').join('/')
    const st = statSync(abs)
    if (st.isDirectory()) {
      walk(abs)
      continue
    }
    if (!SCAN_EXT.test(entry)) continue
    if (rel.endsWith('.d.ts')) continue

    const limit = limitFor(rel, LIMITS)
    if (!limit) continue
    // Count non-blank, non-comment-only lines, matching ESLint max-lines defaults.
    const lines = readFileSync(abs, 'utf8').split('\n')
    const counted = lines.filter((l) => {
      const t = l.trim()
      if (t === '') return false
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) return false
      return true
    }).length
    if (counted > limit.max) {
      violations.push({ rel, counted, ...limit })
    }
  }
}

walk(ROOT)

if (violations.length > 0) {
  console.error(`\nguard:filesize FAILED — ${violations.length} file(s) over their P1.4 limit.\n`)
  console.error('Decompose per P2 / Appendix E, or register a P13.3 exception in Appendix D.\n')
  for (const v of violations.sort((a, b) => b.counted - a.counted)) {
    console.error(`  ${v.rel}\n    ${v.counted} lines > ${v.max} (${v.kind})`)
  }
  console.error('')
  process.exit(1)
}

console.log('guard:filesize OK — every file within its P1.4 limit.')
