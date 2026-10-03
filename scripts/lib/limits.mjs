/**
 * Shared reader + matcher for the P1.4 file-size limit declaration.
 *
 * Both eslint.config.js and scripts/guard-filesize.mjs derive their view of "what is the limit
 * for this file" from here, so there is exactly one place the answer is defined (P1.5 clause 6).
 */
import { readFileSync } from 'node:fs'

const DECL = new URL('../../file-size-limits.json', import.meta.url)

/** @returns {{pattern:string,max:number,kind:string}[]} ordered most-specific-first */
export function loadLimits() {
  return JSON.parse(readFileSync(DECL, 'utf8')).limits
}

/**
 * Minimal glob matcher supporting `**` (any path segments) and `*` (any chars within a segment).
 * Deliberately tiny — a dependency-free matcher keeps the guard runnable before install.
 */
export function globToRegExp(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '.') {
      out += '\\.'
    } else if ('+?^${}()|[]\\'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

/** First matching row wins. @returns {{max:number,kind:string}|null} */
export function limitFor(relPath, limits = loadLimits()) {
  const p = relPath.split('\\').join('/')
  for (const row of limits) {
    if (globToRegExp(row.pattern).test(p)) return { max: row.max, kind: row.kind }
  }
  return null
}
