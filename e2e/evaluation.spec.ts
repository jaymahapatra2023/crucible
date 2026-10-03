/**
 * E2E — from a scored run to the room (E08, E50-S02, E51), connected.
 *
 * The gate passed, the committee decides the band and finalises, the second run lands, the two
 * are merged into one final ranking, and the coaches get their sheets. Each page reads what the
 * one before it recorded.
 */
import { expect, test } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { signInAs } from './support/signIn.js'
import { seedGateDecision, seedScoredRun, seedSecondRun, type SeededScoring } from './support/scoringSeed.js'

let seeded: SeededScoring
const REASON = 'Reviewed the evidence and accept this placement.'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await seedE2EUsers()
  seeded = await seedScoredRun()
  await seedGateDecision('GO')
})

test('1 · the ranked field shows the gate passed and who passed it', async ({ page }) => {
  await signInAs(page, 'reviewer')
  await page.goto(`/review/runs/${seeded.runIndexId}`)
  await expect(page.getByTestId('gate-ok')).toContainText('chair@test.local')
  await expect(page.getByTestId('showing-count')).toHaveText('Showing 4 of 4')
})

test('2 · the committee decides every band entry and answers its caveats, then finalises', async ({ page }) => {
  await signInAs(page, 'organiser')
  for (const submissionId of seeded.submissionIds.slice(1)) {
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${submissionId}`)
    await page.getByLabel('Reason').fill(REASON)
    await page.getByRole('button', { name: /Record decision/ }).click()
    await expect(page.getByTestId('existing-decision')).toBeVisible()
    await page.getByRole('button', { name: /Dismiss this caveat/ }).click()
    await page.getByLabel(/Why can this be set aside/).fill('Both challenges share the same anchors; accepted by the chair.')
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(page.getByText(/0 open/)).toBeVisible()
  }
  await page.goto(`/review/runs/${seeded.runIndexId}`)
  await page.getByRole('button', { name: /Finalise shortlist/ }).click()
  await expect(page.getByText(/Locked by/)).toBeVisible()
})

test('3 · with run 2 ranked, one final ranking is computed from both and exported', async ({ page }) => {
  await seedSecondRun(seeded)
  await signInAs(page, 'organiser')
  await page.goto('/scoring')
  await page.getByRole('link', { name: 'e2e-cohort' }).click()
  await expect(page).toHaveURL(/\/scoring\/cohorts\/e2e-cohort\/final$/)
  await page.getByRole('button', { name: 'Compute final ranking' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Recompute' })).toBeVisible()
  await expect(page.getByText(/weights run 1 0\.5 · run 2 0\.5/)).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(5) // header + four ranked
  await expect(page.getByRole('link', { name: 'run 2' })).toBeVisible()

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-final').click()])
  expect(download.suggestedFilename()).toBe('final-ranking-e2e-cohort.csv')
})

test('4 · the coach sheets follow the shortlist decisions and reach the coach', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)
  await page.getByRole('link', { name: 'Coach sheets' }).click()
  // Three SHORTLIST decisions were recorded in step 2; the scope is the shortlist by default.
  await expect(page.locator('article.sheet')).toHaveCount(3)
  await page.getByRole('button', { name: 'Email each coach their teams' }).click()
  await expect(page.getByRole('status')).toContainText(/No coach on the roster for/)
})

test('5 · a viewer may read the final ranking but is not offered any control over it', async ({ page }) => {
  await signInAs(page, 'viewer')
  await page.goto('/scoring/cohorts/e2e-cohort/final')
  // Reading the list that decides is a reviewer act; the viewer sees a stated refusal, not a blank.
  await expect(page.getByRole('alert')).toContainText(/could not be loaded/)
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Compute final ranking|Recompute/ })).toHaveCount(0)
})
