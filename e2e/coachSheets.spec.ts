/**
 * E2E — coach sheets for the shortlisted teams (E51).
 *
 * The seeded run has no decisions, so the page is read on the "inside the cut line" scope: three
 * teams, one page each, and the coach's questions come from what the run recorded. An admin
 * sees the standing; the send reports who has no coach rather than skipping them silently.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun, type SeededScoring } from './support/scoringSeed.js'

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

test('reached from the ranked field; one sheet per team inside the cut line', async ({ page }) => {
  await signIn(page)
  await page.goto(`/review/runs/${seeded.runIndexId}`)
  await page.getByRole('link', { name: 'Coach sheets' }).click()
  await expect(page).toHaveURL(new RegExp(`/review/runs/${seeded.runIndexId}/coach-sheets$`))

  // Nothing is shortlisted yet; the page says so and offers the cut line.
  await expect(page.getByText('No teams in scope')).toBeVisible()
  await page.getByLabel('Which teams').selectOption('cutline')
  await expect(page.locator('article.sheet')).toHaveCount(3)

  const first = page.getByTestId(`sheet-${seeded.submissionIds[0]}`)
  await expect(first.getByRole('heading', { name: 'Team Scored' })).toBeVisible()
  await expect(first).toContainText('Ada Room')
  await expect(first).toContainText('coach Margaret Hamilton')
  // The originality assessment in the seed is 62% template: the sheet turns it into a question.
  await expect(first).toContainText('Which parts did you write yourselves')
  // The admin's view carries the standing; the text a coach receives does not (API-tested).
  await expect(first.getByTestId('standing')).toContainText('rank 1 in run')
})

test('sending names the teams that have no coach on the roster', async ({ page }) => {
  await signIn(page)
  await page.goto(`/review/runs/${seeded.runIndexId}/coach-sheets?scope=cutline`)
  await page.getByRole('button', { name: 'Email each coach their teams' }).click()
  const status = page.getByRole('status')
  await expect(status).toContainText(/1 coach (sent|prepared but not transmitted)/)
  await expect(status).toContainText('No coach on the roster for: Team Outsider, Team Unevidenced')
})

test('the single sheet is a page of its own from the team review', async ({ page }) => {
  await signIn(page)
  await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)
  await page.getByRole('link', { name: 'Coach sheets' }).click()
  await expect(page.getByRole('heading', { name: /Coach sheets · run/ })).toBeVisible()
})
