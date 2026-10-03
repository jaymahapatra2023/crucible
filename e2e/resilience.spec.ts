/**
 * E2E — when things go wrong (P5.4, P5.7, P8).
 *
 * A failing API is visibly distinct from an empty result on every organiser page; an unknown
 * address is a page, not a blank; a dead session returns to sign-in; a double click sends one
 * entry; and a team name is text, never markup, wherever it is shown.
 */
import { expect, test } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { signInAs } from './support/signIn.js'
import { seedIntake, type SeededIntake } from './support/intakeSeed.js'
import { seedRoster } from './support/rosterSeed.js'

test.beforeAll(async () => { await seedE2EUsers() })

test.describe('a failing API', () => {
  for (const path of ['/intake', '/roster', '/scoring', '/challenges', '/catalogue', '/calibration', '/runs']) {
    test(`${path} shows an error with a retry, not an empty page`, async ({ page }) => {
      await signInAs(page, 'admin')
      await page.route('**/api/v1/**', (route) => route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'The database is unreachable.' } }),
      }))
      await page.goto(path)
      await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
      await expect(page.getByText(/unreachable|could not|failed/i).first()).toBeVisible()
    })
  }

  test('retry recovers once the API answers again', async ({ page }) => {
    await seedRoster()
    await signInAs(page, 'admin')
    let failing = true
    await page.route('**/api/v1/roster/**', (route) => failing
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Try again.' } }) })
      : route.continue())
    await page.goto('/roster')
    await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
    failing = false
    await page.getByRole('button', { name: 'Retry' }).first().click()
    await expect(page.getByTestId('unassigned-count')).toHaveText('4')
  })
})

test.describe('addresses and sessions', () => {
  test('an unknown address is a page that says so and offers the way back', async ({ page }) => {
    await page.goto('/no/such/page')
    await expect(page.getByRole('heading', { name: 'There is nothing at this address' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Submit an entry' })).toBeVisible()
    await signInAs(page, 'viewer')
    await page.goto('/review/runs/abc/nope')
    await expect(page.getByRole('link', { name: 'Go to the app' })).toBeVisible()
  })

  test('a dead session is sent back to sign-in rather than shown errors', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('crucible.token', 'not-a-real-token')
      sessionStorage.setItem('crucible.user', JSON.stringify({ email: 'x@test.local', displayName: 'X', role: 'admin' }))
    })
    await page.goto('/intake')
    await expect(page).toHaveURL(/\/login/)
  })

  test('a staff sign-in never leaks into the public form, and vice versa', async ({ page }) => {
    await seedIntake()
    await page.goto('/submit')
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Intake' })).toHaveCount(0)
    await signInAs(page, 'organiser')
    await page.goto('/submit')
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Intake' })).toBeVisible()
  })
})

test.describe('double clicks and markup', () => {
  let intake: SeededIntake
  test.beforeEach(async () => { intake = await seedIntake() })

  test('a double click on Submit sends one entry', async ({ page }) => {
    await page.goto('/submit')
    const form = page.locator('form')
    await form.getByLabel('Submission token').fill(intake.token)
    await expect(form.getByTestId('resolved-team')).toContainText('E2E team')
    await form.getByLabel('Contact email').fill('team@example.com')
    await form.getByLabel('Challenge').selectOption(String(intake.challengeId))
    await form.getByLabel('Repository URL').fill('https://github.com/example/does-not-exist')

    let posts = 0
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/submissions')) posts++ })
    await page.getByRole('button', { name: 'Submit entry' }).evaluate((b: HTMLButtonElement) => { b.click(); b.click() })
    await expect(page.getByRole('heading', { name: 'Entry received' })).toBeVisible({ timeout: 40_000 })
    expect(posts).toBe(1)
  })

  test('a team name with markup is shown as text on intake and the roster', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto('/intake')
    const row = page.getByRole('table', { name: 'Submission tokens' }).getByRole('row', { name: /E2E team/ })
    await row.getByRole('button', { name: /^Edit team/ }).click()
    const form = row.getByRole('form', { name: /^Edit team/ })
    await form.getByLabel('Team name').fill('<b>Bold</b> & <img src=x onerror=alert(1)>')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('table', { name: 'Submission tokens' }))
      .toContainText('<b>Bold</b> & <img src=x onerror=alert(1)>')
    expect(await page.locator('table img').count()).toBe(0)

    await page.goto('/roster')
    await expect(page.getByRole('list', { name: 'Teams' })).toContainText('<b>Bold</b>')
    expect(await page.locator('main b').count()).toBe(0)
  })
})
