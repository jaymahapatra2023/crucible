/**
 * E2E — authentication journey (P8.1, P5.4).
 */
import { expect, test } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'

test.beforeAll(async () => {
  await seedE2EUsers()
})

test.describe('sign-in', () => {
  test('a signed-out visitor is routed to sign-in, not to a wall of errors', async ({ page }) => {
    await page.goto('/runs')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: /sign in to crucible/i })).toBeVisible()
  })

  test('valid credentials sign in and land on the runs view', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(E2E_USERS.admin.email)
    await page.getByLabel('Password').fill(E2E_USERS.admin.password)
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page).toHaveURL(/\/runs$/)
    await expect(page.getByText(E2E_USERS.admin.role)).toBeVisible()
  })

  test('invalid credentials show a plain-language error and stay on the page', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(E2E_USERS.admin.email)
    await page.getByLabel('Password').fill('definitely-the-wrong-password')
    await page.getByRole('button', { name: /sign in/i }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/not recognised/i)
    await expect(page).toHaveURL(/\/login$/)
  })

  test('the error never reveals whether the account exists', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('no-such-person@test.local')
    await page.getByLabel('Password').fill('some-password-here')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('alert')).toContainText(/not recognised/i)
  })

  test('signing out returns to sign-in and protects the app again', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(E2E_USERS.reviewer.email)
    await page.getByLabel('Password').fill(E2E_USERS.reviewer.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/runs$/)

    await page.getByRole('button', { name: /sign out/i }).click()
    await expect(page).toHaveURL(/\/login$/)

    await page.goto('/runs')
    await expect(page).toHaveURL(/\/login$/)
  })
})
