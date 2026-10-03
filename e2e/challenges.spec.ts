/**
 * E2E — an organiser setting up a challenge (E02).
 *
 * The page's job is to make the order of the work visible, because the failure it prevents is
 * silent: a rubric generated from a brief whose text was never extracted produces criteria that
 * cite passages nobody can open, and it looks entirely normal until someone follows a citation.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

const uniqueName = () => `E2E challenge ${Date.now().toString(36)}`

test.beforeAll(async () => { await seedE2EUsers() })

test.describe('the challenges page', () => {
  test('is reachable from the primary navigation', async ({ page }) => {
    await signIn(page)
    await page.getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Challenges' }).click()
    await expect(page.getByRole('heading', { name: 'Challenges', level: 1 })).toBeVisible()
  })

  test('states the order the work has to happen in', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await expect(
      page.getByText('Upload the brief, extract its text, generate a rubric from what it says.'),
    ).toBeVisible()
  })
})

test.describe('creating a challenge', () => {
  test('creates it and says what comes next', async ({ page }) => {
    const name = uniqueName()
    await signIn(page)
    await page.goto('/challenges')

    await page.getByRole('button', { name: 'New challenge' }).first().click()
    await page.locator('form').getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create challenge' }).click()

    await expect(page.getByRole('status')).toContainText('Upload its brief next')
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
  })

  test('will not generate a rubric before any text has been extracted', async ({ page }) => {
    const name = uniqueName()
    await signIn(page)
    await page.goto('/challenges')

    await page.getByRole('button', { name: 'New challenge' }).first().click()
    await page.locator('form').getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create challenge' }).click()

    // The step is visible but unavailable, and the page says why rather than failing on click.
    await expect(page.getByRole('button', { name: 'Generate rubric' })).toBeDisabled()
    await expect(page.getByText(/once at least one document's text has been extracted/i))
      .toBeVisible()
  })

  test('says the brief comes first, because criteria are derived from it', async ({ page }) => {
    const name = uniqueName()
    await signIn(page)
    await page.goto('/challenges')

    await page.getByRole('button', { name: 'New challenge' }).first().click()
    await page.locator('form').getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create challenge' }).click()

    await expect(page.getByText(/Criteria are derived from the brief, so this comes first/i))
      .toBeVisible()
    await expect(page.getByText(/cite passages nobody can check/i)).toBeVisible()
  })
})
