/**
 * The two views of the P1.4 limit declaration must agree (P1.5 clause 6).
 *
 * `file-size-limits.json` is the single declaration, and two things derive from it: the guard
 * (`limitFor`, first-matching-row-wins) and ESLint's `max-lines` overrides. ESLint flat config
 * applies every matching block and lets the LAST one win, which is the opposite rule — so the
 * config emits the rows reversed.
 *
 * That inversion is easy to lose in a refactor and produced a real defect before this test
 * existed: a test file under `apps/web/src` was held to the 250-line React-component limit by
 * ESLint while the guard allowed it 500. Neither number was wrong; they simply disagreed, which
 * is the failure mode having one declaration is supposed to make impossible.
 */
import { describe, expect, it } from 'vitest'
import { loadLimits, limitFor } from './lib/limits.mjs'
import config from '../eslint.config.js'
import { globToRegExp } from './lib/limits.mjs'

/** What ESLint would apply: every matching block, last one wins. */
function eslintLimitFor(path) {
  let max = null
  for (const block of config) {
    const files = block?.files
    const rule = block?.rules?.['max-lines']
    if (!files || !rule) continue
    if (files.some((pattern) => globToRegExp(pattern).test(path))) max = rule[1].max
  }
  return max
}

const SAMPLES = [
  // The case that actually broke: a test file living under the web app.
  'apps/web/src/components/reviewUi.test.tsx',
  'apps/web/src/components/ScoreCard.tsx',
  'apps/web/src/pages/ReviewPage.tsx',
  'apps/api/src/modules/scoring/services/rankingService.ts',
  'apps/api/src/modules/review/db/flagDb.ts',
  'apps/api/src/modules/review/routes/reviewRoutes.ts',
  'apps/api/src/lib/csv.ts',
  'apps/api/tests/integration/shortlist.test.ts',
  'packages/scoring/src/composite.ts',
  'packages/scoring/src/types.ts',
]

describe('the guard and ESLint derive the same limit', () => {
  for (const path of SAMPLES) {
    it(`agrees on ${path}`, () => {
      expect(eslintLimitFor(path)).toBe(limitFor(path)?.max)
    })
  }

  it('covers every TypeScript pattern in the declaration', () => {
    for (const row of loadLimits().filter((r) => /\.(ts|tsx)$/.test(r.pattern))) {
      // A concrete path that this row, and only more specific rows, could match.
      const probe = row.pattern.replace(/\*\*\//g, 'a/b/').replace(/\*/g, 'x')
      expect(eslintLimitFor(probe), row.pattern).toBe(limitFor(probe)?.max)
    }
  })
})
