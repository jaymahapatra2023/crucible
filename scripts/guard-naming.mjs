#!/usr/bin/env node
/**
 * P10.2 gate 8 — no upstream-platform reference anywhere in the tree.
 *
 * Crucible borrows patterns from an upstream reference implementation. Borrowed code is
 * renamed to Crucible-native naming on the way in. This guard makes that rule enforceable
 * instead of aspirational: any reintroduction of the upstream product's vocabulary, in a
 * filename or in file content, fails CI.
 *
 * The forbidden terms are assembled from fragments so that this file does not itself contain
 * the literal strings it bans.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** Forbidden vocabulary, assembled so this file stays clean under its own rule. */
const FORBIDDEN = [
  ['meri', 'dian'].join(''),
  ['mrd', '_live'].join(''),
  ['@meri', 'dian-v2'].join(''),
  ['aidlc'].join(''),
  ['sdlc_', 're_gap'].join(''),
]

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.turbo', '.next',
  'playwright-report', 'test-results', '.tmp', '.pnpm-store',
])

/** Binary and lockfile extensions we never scan. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mov', '.xlsx', '.pptx', '.docx',
])

/** Files exempt from the content scan (the guards themselves, and the memory of the rule). */
const SELF = new Set([
  join('scripts', 'guard-naming.mjs'),
  'pnpm-lock.yaml',
])

const violations = []

function walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    const rel = relative(ROOT, abs)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(abs)
      continue
    }
    const lowerRel = rel.toLowerCase()
    for (const term of FORBIDDEN) {
      if (lowerRel.includes(term)) {
        violations.push({ file: rel, line: 0, term, kind: 'filename' })
      }
    }
    const dot = entry.lastIndexOf('.')
    if (dot >= 0 && SKIP_EXT.has(entry.slice(dot).toLowerCase())) continue
    if (SELF.has(rel) || SELF.has(rel.split(sep).join('/'))) continue
    if (st.size > 2_000_000) continue

    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    for (const term of FORBIDDEN) {
      if (!lower.includes(term)) continue
      text.split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(term)) {
          violations.push({ file: rel, line: i + 1, term, kind: 'content', text: line.trim().slice(0, 120) })
        }
      })
    }
  }
}

walk(ROOT)

if (violations.length > 0) {
  console.error(`\nguard:naming FAILED — ${violations.length} upstream-platform reference(s) found.\n`)
  console.error('Crucible must carry no reference to the upstream platform it borrows patterns from.')
  console.error('Rename the file or symbol to Crucible-native naming; record provenance in docs/adr/ in neutral terms.\n')
  for (const v of violations.slice(0, 50)) {
    if (v.kind === 'filename') console.error(`  ${v.file}  [filename contains a banned term]`)
    else console.error(`  ${v.file}:${v.line}  ${v.text}`)
  }
  if (violations.length > 50) console.error(`  … and ${violations.length - 50} more`)
  console.error('')
  process.exit(1)
}

console.log('guard:naming OK — no upstream-platform references found.')
