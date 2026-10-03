/**
 * E2E — the organiser pages at phone width (E50-S06).
 *
 * On the night, intake, the roster, the ranked field and the coach sheets are read from whatever
 * is to hand. None may scroll sideways, and the first action on each must be reachable.
 */
import { expect, test } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { sidewaysOverflow, signInAs } from './support/signIn.js'
import { seedIntake } from './support/intakeSeed.js'
import { seedRoster } from './support/rosterSeed.js'
import { seedGateDecision, seedScoredRun, type SeededScoring } from './support/scoringSeed.js'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
test.beforeAll(async () => { await seedE2EUsers() })

test('intake fits and the chase list is usable', async ({ page }) => {
  await seedIntake()
  await signInAs(page, 'organiser')
  await page.goto('/intake')
  await expect(page.getByTestId('count-submitted')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Not there yet/ })).toBeVisible()
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
})

test('the roster fits and assignment works by typing', async ({ page }) => {
  await seedRoster()
  await signInAs(page, 'organiser')
  await page.goto('/roster')
  await page.getByLabel('Find a participant').fill('ada')
  await page.getByLabel('Find a participant').press('Enter')
  await expect(page.getByTestId('unassigned-count')).toHaveText('3')
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
})

test.describe('with a scored run', () => {
  let seeded: SeededScoring
  test.beforeEach(async () => { seeded = await seedScoredRun(); await seedGateDecision('GO') })

  for (const [name, path] of [
    ['the ranked field', (s: SeededScoring) => `/review/runs/${s.runIndexId}`],
    ['a team review', (s: SeededScoring) => `/review/runs/${s.runIndexId}/teams/${s.submissionIds[0]}`],
    ['the coach sheets', (s: SeededScoring) => `/review/runs/${s.runIndexId}/coach-sheets?scope=cutline`],
    ['the scoring runs', () => '/scoring'],
    ['health', () => '/health'],
  ] as const) {
    test(`${name} fits a phone`, async ({ page }) => {
      await signInAs(page, 'organiser')
      await page.goto(path(seeded))
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
    })
  }
})
