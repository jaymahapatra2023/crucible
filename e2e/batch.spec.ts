/**
 * E2E — an operator checking on an overnight run (E10-S05).
 *
 * The journey that makes the story worth building: somebody opens this page at 3am, having not
 * seen it before, and has to decide whether to intervene. Everything they need is read from what
 * the run wrote down — which is what "survives page reload" actually means.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedBatchRun } from './support/scoringSeed.js'

let runId: number

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { ({ runId } = await seedBatchRun()) })

test.describe('watching a cohort run', () => {
  test('shows progress per stage with counts', async ({ page }) => {
    await signIn(page)
    await page.goto(`/batch/runs/${runId}`)

    await expect(page.getByTestId('stage-scan')).toContainText('4 of 4')
    await expect(page.getByTestId('stage-probe')).toContainText('3 of 4')
    await expect(page.getByTestId('stage-score')).toContainText('2 of 4')
  })

  test('SURVIVES a reload — nothing depends on a live message (acceptance 2)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/batch/runs/${runId}`)
    await expect(page.getByTestId('overall-progress')).toContainText('9 of 16 steps')

    await page.reload()

    // Identical after a reload, because it was read rather than accumulated.
    await expect(page.getByTestId('overall-progress')).toContainText('9 of 16 steps')
    await expect(page.getByTestId('stage-scan')).toContainText('4 of 4')
  })

  test('explains WHY the run stopped, in money terms', async ({ page }) => {
    await signIn(page)
    await page.goto(`/batch/runs/${runId}`)

    await expect(page.getByTestId('run-status')).toHaveText('PAUSED')
    await expect(page.getByTestId('paused-reason'))
      .toContainText('above the $250.00 ceiling')
    await expect(page.getByTestId('paused-reason'))
      .toContainText('ceiling can be raised or the cohort reduced')
  })

  test('shows spend and the projected total', async ({ page }) => {
    await signIn(page)
    await page.goto(`/batch/runs/${runId}`)

    await expect(page.getByTestId('cost')).toContainText('$41.50 spent')
    await expect(page.getByTestId('projected')).toContainText('$415.00 projected')
  })

  test('lists the failure and says the run carried on', async ({ page }) => {
    await signIn(page)
    await page.goto(`/batch/runs/${runId}`)

    await expect(page.getByText(/the repository vanished mid-clone/)).toBeVisible()
    await expect(page.getByText(/left unmeasured/)).toBeVisible()
  })

  test('is readable without an organiser account', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(E2E_USERS.reviewer.email)
    await page.getByLabel('Password').fill(E2E_USERS.reviewer.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    // Wait for the session to be established: navigating mid-sign-in lands on the login page.
    await expect(page).toHaveURL(/\/runs$/)
    await page.goto(`/batch/runs/${runId}`)

    await expect(page.getByTestId('run-status')).toHaveText('PAUSED')
  })
})
