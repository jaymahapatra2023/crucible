/**
 * E2E — the seams between modules (E17, E45, E47, E48, E27).
 *
 * A code replaced on intake stops working on the public form at once; a lock on intake closes
 * the public form and keeps the team's own view; a team renamed on intake is renamed on the
 * roster; a team placed on the roster is placed on intake. One fact, every screen.
 */
import { expect, test, type Page } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { signInAs } from './support/signIn.js'
import { seedIntake, type SeededIntake } from './support/intakeSeed.js'

let intake: SeededIntake
test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { intake = await seedIntake() })

async function checkEntry(page: Page, token: string) {
  await page.goto('/submit')
  await page.locator('form').getByLabel('Submission token').fill(token)
  await page.getByRole('button', { name: 'Check my entry' }).click()
}

test('a replaced code stops working on the public form, and the new one works', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto('/intake')
  const teamSelect = page.getByLabel('Team', { exact: true })
  const option = teamSelect.locator('option', { hasText: 'E2E team' })
  await teamSelect.selectOption(await option.getAttribute('value') ?? '')
  await page.getByLabel(/Why the code is being replaced/).fill('the contact lost it')
  await page.getByRole('button', { name: /Replace this team's code/ }).click()
  await expect(page.getByText(/previous code has stopped working/)).toBeVisible()
  const fresh = (await page.locator('code', { hasText: /^crs_/ }).first().textContent())?.trim() ?? ''
  expect(fresh).not.toBe(intake.token)

  await checkEntry(page, intake.token)
  await expect(page.getByRole('alert')).toContainText(/not valid|no longer|revoked/i)
  await checkEntry(page, fresh)
  await expect(page.getByText(/no entry recorded yet/i)).toBeVisible()
})

test('a rename on intake is the name on the roster and on the public form', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto('/intake')
  const row = page.getByRole('table', { name: 'Submission tokens' }).getByRole('row', { name: /E2E team/ })
  await row.getByRole('button', { name: /^Edit team/ }).click()
  const form = row.getByRole('form', { name: /^Edit team/ })
  await form.getByLabel('Team name').fill('Renamed Team')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('table', { name: 'Submission tokens' })).toContainText('Renamed Team')

  await page.goto('/roster')
  await expect(page.getByRole('list', { name: 'Teams' })).toContainText('Renamed Team')

  await page.goto('/submit')
  await page.locator('form').getByLabel('Submission token').fill(intake.token)
  await expect(page.locator('form').getByTestId('resolved-team')).toContainText('Renamed Team')
})

test('a team placed on the roster is shown with its room and coach on intake', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto('/roster')
  const tab = (name: string) => page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name })
  await tab('Rooms & coaches').click()
  await page.getByLabel('Room label').fill('Babbage')
  await page.getByLabel('Room location').fill('Second floor')
  await page.getByRole('button', { name: 'Add room' }).click()
  await page.getByLabel('Coach name').fill('Katherine Johnson')
  await page.getByLabel('Coach email').fill('kj@example.test')
  await page.getByRole('button', { name: 'Add coach' }).click()
  await tab('Logistics').click()
  await page.getByLabel('Coach for E2E team').selectOption({ label: 'Katherine Johnson' })
  await page.getByLabel('Room for E2E team').selectOption({ label: 'Babbage — Second floor' })

  // Intake's "where to find them" reads the same logistics view.
  await page.goto('/submit')
  const form = page.locator('form')
  await form.getByLabel('Submission token').fill(intake.token)
  await form.getByLabel('Contact email').fill('team@example.com')
  await form.getByLabel('Challenge').selectOption(String(intake.challengeId))
  await form.getByLabel('Repository URL').fill('https://github.com/example/does-not-exist')
  await page.getByRole('button', { name: 'Submit entry' }).click()
  await expect(page.getByRole('heading', { name: 'Entry received' })).toBeVisible({ timeout: 40_000 })

  await page.goto('/intake')
  const chasing = page.getByRole('table', { name: 'Submissions needing chasing' })
  await expect(chasing.getByRole('row', { name: /E2E team/ })).toContainText(/Babbage/)
  await expect(chasing.getByRole('row', { name: /E2E team/ })).toContainText(/Katherine Johnson/)
})

test('the health page reports delivery and the safety ceilings, for any signed-in role', async ({ page }) => {
  await signInAs(page, 'viewer')
  await page.goto('/health')
  await expect(page.getByRole('heading', { name: 'Safety ceilings' })).toBeVisible()
  await expect(page.getByText('Team delivery')).toBeVisible()
  await expect(page.getByText(/mail: .*; Discord DM: (live|off|unconfigured)/)).toBeVisible()
})
