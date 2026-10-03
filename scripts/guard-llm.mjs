#!/usr/bin/env node
/**
 * P10.2 gate 9 / P3.1 — no direct LLM provider call outside the gateway.
 *
 * Every LLM call must route through `llmGateway.callModel()` with a registered callKey so that
 * it is configured, audited, retried, cost-accounted and observable. A service that reaches a
 * provider SDK directly bypasses all five. This guard fails CI on that pattern.
 *
 * The only directory permitted to import a provider SDK is the gateway's own provider adapter
 * directory (P12.2 — external integrations isolated in adapters).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** Only these paths may speak to a provider directly. */
const ALLOWED_PREFIXES = [
  'apps/api/src/modules/llm/providers/',
  'scripts/',
]

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'playwright-report',
  'test-results', '.tmp', 'docs',
])

const BANNED = [
  { re: /\bnew\s+Anthropic\s*\(/, why: 'direct provider client construction (P3.1)' },
  { re: /from\s+['"]@anthropic-ai\/sdk['"]/, why: 'provider SDK import outside the adapter (P3.1/P12.2)' },
  { re: /require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/, why: 'provider SDK require outside the adapter (P3.1/P12.2)' },
  { re: /from\s+['"]openai['"]/, why: 'provider SDK import outside the adapter (P3.1/P12.2)' },
  { re: /https?:\/\/api\.anthropic\.com/, why: 'hand-rolled HTTP call to a provider API (P3.1)' },
  { re: /https?:\/\/api\.openai\.com/, why: 'hand-rolled HTTP call to a provider API (P3.1)' },
]

const violations = []

function allowed(rel) {
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p))
}

function walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    const rel = relative(ROOT, abs).split('\\').join('/')
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
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) continue
    if (allowed(rel)) continue

    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
      for (const b of BANNED) {
        if (b.re.test(line)) {
          violations.push({ file: rel, line: i + 1, why: b.why, text: line.trim().slice(0, 110) })
        }
      }
    })
  }
}

walk(ROOT)

if (violations.length > 0) {
  console.error(`\nguard:llm FAILED — ${violations.length} direct provider call(s) outside the gateway.\n`)
  console.error('Route the call through llmGateway.callModel({ callKey, ... }) with a registered callKey.\n')
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.why}\n    ${v.text}`)
  console.error('')
  process.exit(1)
}

console.log('guard:llm OK — every LLM call routes through the gateway.')
