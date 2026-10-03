/**
 * E2E — a reviewer checking a security observation (E16-S03).
 *
 * Every observation ships with what would make it benign. The journey worth testing is what
 * happens after a reviewer checks it: the observation stays visible and marked, the tile stops
 * demanding attention, and the reason is there for whoever reads this months later.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun, type SeededScoring } from './support/scoringSeed.js'
import { seedDiscovery } from './support/discoverySeed.js'

let seeded: SeededScoring
let submissionId: number

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

async function openSecurity(page: Page) {
  await page.goto(`/submissions/${submissionId}/discovery`)
  await page.getByRole('button', { name: /Security observations/ }).click()
}

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => {
  seeded = await seedScoredRun()
  submissionId = seeded.submissionIds[0]!
  await seedDiscovery(submissionId)
})

test.describe('checking an observation', () => {
  test('asks what was checked, and says who the answer is for', async ({ page }) => {
    await signIn(page)
    await openSecurity(page)

    await page.getByRole('button', { name: /I checked this/i }).first().click()
    await expect(page.getByLabel(/What did you check\?/i).first()).toBeVisible()
    await expect(page.getByText(/next reviewer reads this instead of repeating your work/i).first())
      .toBeVisible()
  })

  test('keeps it VISIBLE and marked afterwards, never hidden', async ({ page }) => {
    // Hiding it would make a checked observation and an unexamined one look identical.
    await signIn(page)
    await openSecurity(page)

    await page.getByRole('button', { name: /I checked this/i }).first().click()
    await page.getByLabel(/What did you check\?/i).first()
      .fill('The caller validates the metric against a fixed list first.')
    await page.getByRole('button', { name: 'Set aside' }).click()

    await expect(page.getByText(/Checked and set aside/i)).toBeVisible()
    await expect(page.getByText(/validates the metric against a fixed list/)).toBeVisible()
    // The observation itself is still on the page.
    await expect(page.getByText('INJECTION_RISK').first()).toBeVisible()
  })

  test('stops the tile demanding attention once nothing is left to check', async ({ page }) => {
    await signIn(page)

    const tile = page.getByRole('button', { name: /Security observations/ })
    await page.goto(`/submissions/${submissionId}/discovery`)
    await expect(tile).toHaveAttribute('data-warn', 'true')

    await tile.click()
    await page.getByRole('button', { name: /I checked this/i }).first().click()
    await page.getByLabel(/What did you check\?/i).first()
      .fill('Checked against the caller; the input is validated before it reaches this line.')
    await page.getByRole('button', { name: 'Set aside' }).click()
    await expect(page.getByText(/Checked and set aside/)).toBeVisible()

    // The amber goes — there is nothing left to look at...
    await expect(tile).toHaveAttribute('data-warn', 'false')
    // ...and the count stays, because checking an observation does not make it stop having
    // existed.
    await expect(tile).toContainText('1')
  })

  test('can put one back', async ({ page }) => {
    await signIn(page)
    await openSecurity(page)

    await page.getByRole('button', { name: /I checked this/i }).first().click()
    await page.getByLabel(/What did you check\?/i).first()
      .fill('Believed benign; confirming with the author before the deadline.')
    await page.getByRole('button', { name: 'Set aside' }).click()
    await expect(page.getByText(/Checked and set aside/)).toBeVisible()

    await page.getByRole('button', { name: /Put it back/i }).click()
    await expect(page.getByRole('button', { name: /I checked this/i }).first()).toBeVisible()
  })
})

test.describe('comparing with the previous discovery', () => {
  test('says there is nothing to compare after one run', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await page.getByRole('button', { name: /Compare with the previous discovery/i }).click()
    await expect(page.getByTestId('changes-none'))
      .toContainText(/nothing to compare it with/i)
  })
})
