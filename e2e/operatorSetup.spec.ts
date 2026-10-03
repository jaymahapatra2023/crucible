/**
 * E2E — an organiser configuring the event and working the provenance queue (E19).
 *
 * Both surfaces exist because their absence was silent. Two settings shipped unset and disabled
 * what depended on them with no sign anywhere; flagged commit histories had a query returning
 * them and nothing that called it.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedIntake } from './support/intakeSeed.js'
import { seedFlaggedProvenance, clearProvenance } from './support/provenanceSeed.js'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => {
  await seedIntake()
  await clearProvenance()
})

test.describe('setting up the event', () => {
  test('says what the evaluation date is for, not just its name', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await expect(page.getByText(/days before it, and until this is set that cannot be checked/i))
      .toBeVisible()
  })

  test('says the event window flags rather than excludes', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await expect(page.getByText(/never excluded, and never acted on automatically/i))
      .toBeVisible()
  })

  test('saves the evaluation date and shows it afterwards', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel(/Evaluation date/).fill('2026-11-14')
    await page.getByRole('button', { name: /save the date/i }).click()

    await expect(page.getByRole('status').filter({ hasText: /./ }).first()).toBeVisible()
    await page.reload()
    await expect(page.getByLabel(/Evaluation date/)).toHaveValue('2026-11-14')
  })
})

test.describe('working the provenance queue', () => {
  test('says nothing is flagged, and why that might be misleading', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await expect(page.getByText(/flagging needs an event window to be set/i)).toBeVisible()
  })

  test('lists a flagged history with what was observed', async ({ page }) => {
    await seedFlaggedProvenance(1, 88)
    await signIn(page)
    await page.goto('/intake')

    await expect(page.getByTestId('provenance-1')).toBeVisible()
    await expect(page.getByText(/One commit contributed most of the code/)).toBeVisible()
    await expect(page.getByText(/Nothing here excludes a submission/i)).toBeVisible()
  })

  test('records a conclusion and keeps the entry visible afterwards', async ({ page }) => {
    await seedFlaggedProvenance(1, 88)
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel(/What did you conclude\?/i)
      .fill('The team squashed their history before submitting; the authors check out.')
    await page.getByRole('button', { name: /record this/i }).click()

    const row = page.getByTestId('provenance-1')
    await expect(row).toHaveAttribute('data-resolved', 'true')
    await expect(row).toContainText('Looked at')
    await expect(row).toContainText('squashed their history')
  })

  test('REFUSES a conclusion too short to be one', async ({ page }) => {
    await seedFlaggedProvenance(1, 88)
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel(/What did you conclude\?/i).fill('fine')
    await expect(page.getByRole('button', { name: /record this/i })).toBeDisabled()
  })
})
