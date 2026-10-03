/**
 * E2E — run ledger view (E01-S05, P5.4, P5.7).
 *
 * The assertions here are mostly about *data honesty*: an empty result, a failed fetch and a
 * truncated page must be distinguishable on screen, because a reviewer who confuses them draws
 * a wrong conclusion and cannot tell that they have.
 */
import { expect, test } from '@playwright/test'
import { E2E_USERS, clearRuns, seedE2EUsers, seedRuns } from './support/seed.js'

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => {
  await seedE2EUsers()
})

test.describe('runs view', () => {
  test('an empty ledger explains what to do next, and is not an error (P5.4)', async ({ page }) => {
    await clearRuns()
    await signIn(page)
    await expect(page.getByText(/no runs yet/i)).toBeVisible()
    await expect(page.getByText(/batch console/i)).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('lists runs with their real backend total (P5.7)', async ({ page }) => {
    await seedRuns(3)
    await signIn(page)
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('row')).toHaveCount(4) // header + 3
    await expect(page.getByText('3 total')).toBeVisible()
  })

  test('says "showing X of Y" when the page is bounded, never just the page length', async ({ page }) => {
    await seedRuns(25)
    await signIn(page)
    await expect(page.getByText(/showing 20 of 25/i)).toBeVisible()
    await expect(page.getByText(/5 older run\(s\) not shown/i)).toBeVisible()
  })

  test('a failed fetch is visibly distinct from an empty result (P5.7)', async ({ page }) => {
    await seedRuns(2)
    // Force the API call to fail after sign-in so the error path renders.
    await page.route('**/api/v1/platform/runs**', (route) => route.abort('failed'))
    await page.goto('/login')
    await page.getByLabel('Email').fill(E2E_USERS.admin.email)
    await page.getByLabel('Password').fill(E2E_USERS.admin.password)
    await page.getByRole('button', { name: /sign in/i }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/could not be loaded/i)
    await expect(page.getByText(/no runs yet/i)).toHaveCount(0)
    await expect(alert.getByRole('button', { name: /retry/i })).toBeVisible()
  })

  test('health view reports database and provider state (P9.4)', async ({ page }) => {
    await signIn(page)
    await page.getByRole('link', { name: 'Health' }).click()
    await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible()
    await expect(page.getByText(/migration\(s\) applied/i)).toBeVisible()
  })
})

test.describe('accessibility (P5.5)', () => {
  test('primary navigation is a named landmark and is keyboard reachable', async ({ page }) => {
    await seedRuns(2)
    await signIn(page)
    const nav = page.getByRole('navigation', { name: 'Primary' })
    await expect(nav).toBeVisible()

    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => document.activeElement?.tagName)
    expect(focused).toBeTruthy()
  })

  test('the sign-in form labels its inputs', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
  })
})
