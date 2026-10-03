/**
 * E2E — a reviewer told that a ranked field was not evidenced evenly (E15-S04).
 *
 * The fairness journey of this epic. Discovery feeds the principles and standards evaluators, so
 * a field where some submissions were described and some were not is a field scored on unequal
 * context — against the same rubric, in the same ranking. Before this, nothing said so.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun, type SeededScoring } from './support/scoringSeed.js'
import { clearDiscovery, seedDiscovery } from './support/discoverySeed.js'

let seeded: SeededScoring

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { seeded = await seedScoredRun() })

test.describe('a field evidenced unevenly', () => {
  test('warns beside the ranking, naming how many were judged on less context', async ({ page }) => {
    // One of four described: the ranking orders submissions that were not treated alike.
    await clearDiscovery()
    await seedDiscovery(seeded.submissionIds[0]!)

    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)

    const banner = page.getByTestId('coverage-uneven')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('not evidenced evenly')
    await expect(banner).toContainText('judged on less context than their competitors')
  })

  test('says what to do about it, not only that it happened', async ({ page }) => {
    await clearDiscovery()
    await seedDiscovery(seeded.submissionIds[0]!)

    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByTestId('coverage-uneven'))
      .toContainText(/re-score, or treat this ranking as provisional/i)
  })
})

test.describe('a field that needs no warning', () => {
  test('stays silent when nobody was described — consistent is fair', async ({ page }) => {
    // Warning here would train a reviewer to scroll past the warning that matters.
    await clearDiscovery()

    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByTestId('coverage-uneven')).toHaveCount(0)
  })

  test('still shows the ranking itself', async ({ page }) => {
    await clearDiscovery()
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByRole('table').first()).toBeVisible()
  })
})
