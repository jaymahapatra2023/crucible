/**
 * E2E — finding a rubric and changing what it weighs (E02-S06, E02-S07).
 *
 * Two things this exists to hold: that a rubric is REACHABLE (it was three clicks deep behind
 * "Set up", with no link from the challenge row), and that a frozen one offers a way forward
 * rather than a dead end — it says "create a new version to change it" and now has the button
 * that does it.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun } from './support/scoringSeed.js'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => { await seedE2EUsers() })
// The challenge, its frozen rubric and its criteria — this spec navigates to them by name
// rather than by id, so the seeded ids are not needed.
test.beforeEach(async () => { await seedScoredRun() })

test.describe('reaching a rubric', () => {
  test('is one click from the challenges list', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')

    const row = page.getByRole('row', { name: /Scoring Challenge/ })
    await row.getByRole('link', { name: /^v\d+$/ }).click()

    await expect(page).toHaveURL(/\/rubrics\/\d+$/)
    await expect(page.getByRole('heading', { name: /Rubric v/ })).toBeVisible()
  })

  test('names the version and its status on the row, so the link is not a guess', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')

    const row = page.getByRole('row', { name: /Scoring Challenge/ })
    await expect(row).toContainText('v1')
    await expect(row).toContainText('frozen')
  })
})

test.describe('a frozen rubric', () => {
  test('shows the weights but refuses to edit them', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await page.getByRole('row', { name: /Scoring Challenge/ })
      .getByRole('link', { name: /^v\d+$/ }).click()

    await expect(page.getByRole('heading', { name: 'How much each dimension counts' }))
      .toBeVisible()
    for (const input of await page.getByLabel(/Weight for /).all()) {
      await expect(input).toBeDisabled()
    }
  })

  test('offers a way forward instead of a dead end', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await page.getByRole('row', { name: /Scoring Challenge/ })
      .getByRole('link', { name: /^v\d+$/ }).click()

    await expect(page.getByText(/teams were shown it, so it stays as it was/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /Create a new version from this one/ }))
      .toBeVisible()
  })

  test('the new version carries the criteria forward and is editable', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await page.getByRole('row', { name: /Scoring Challenge/ })
      .getByRole('link', { name: /^v\d+$/ }).click()
    const frozenUrl = page.url()

    await page.getByRole('button', { name: /Create a new version from this one/ }).click()

    // A different rubric, at version 2, in DRAFT — with the criteria copied across.
    await expect(page).not.toHaveURL(frozenUrl)
    await expect(page.getByRole('heading', { name: /Rubric v2/ })).toBeVisible()
    await expect(page.getByText('DRAFT')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Handles failures without losing work' }),
    ).toBeVisible()

    // And now the weights can actually be changed.
    await expect(page.getByLabel('Weight for Challenge fidelity')).toBeEnabled()
  })
})

test.describe('changing what the rubric weighs', () => {
  test('refuses weights that do not total one, and says nothing is rescaled', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await page.getByRole('row', { name: /Scoring Challenge/ })
      .getByRole('link', { name: /^v\d+$/ }).click()
    await page.getByRole('button', { name: /Create a new version from this one/ }).click()
    await expect(page.getByRole('heading', { name: /Rubric v2/ })).toBeVisible()

    await page.getByLabel('Weight for Runs (build & execute)').fill('0.5')

    await expect(page.getByRole('button', { name: 'Save dimension weights' })).toBeDisabled()
    await expect(page.getByText(/Nothing is rescaled for you/)).toBeVisible()
  })

  test('says a zero-weighted dimension is not assessed at all', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await page.getByRole('row', { name: /Scoring Challenge/ })
      .getByRole('link', { name: /^v\d+$/ }).click()
    await page.getByRole('button', { name: /Create a new version from this one/ }).click()
    await expect(page.getByRole('heading', { name: /Rubric v2/ })).toBeVisible()

    // The seeded rubric weights fidelity at 1.0 and everything else at 0.
    await expect(page.getByText('— not scored at all').first()).toBeVisible()
    await expect(page.getByText(/different from being assessed and scoring badly/i))
      .toBeVisible()
  })
})
