/**
 * E2E — the participant pages on a phone (E50).
 *
 * The two public pages are used from phones pointed at a QR code. The properties: the page fits
 * the viewport with no sideways scroll, the form is usable, and the header shows a participant
 * nothing that implies an account.
 */
import { expect, test } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { E2E_LINK, seedRegistration } from './support/registrationSeed.js'
import { seedIntake } from './support/intakeSeed.js'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test.beforeAll(async () => { await seedE2EUsers() })

test.describe('on a phone', () => {
  test('the registration form fits and asks for nothing that implies an account', async ({ page }) => {
    await seedRegistration()
    await page.goto(`/register?link=${E2E_LINK}`)
    await expect(page.getByText(/Registering as/)).toBeVisible()
    await expect(page.getByLabel('Team name')).toBeVisible()

    const nav = page.getByRole('navigation', { name: 'Primary' })
    await expect(nav).toContainText('Register')
    await expect(nav).not.toContainText('Roster')

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('the submit form fits, and the token field is usable', async ({ page }) => {
    const intake = await seedIntake()
    await page.goto('/submit')
    await page.getByLabel('Submission token').fill(intake.token)
    await expect(page.getByTestId('resolved-team')).toContainText('Submitting as', { timeout: 10_000 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
