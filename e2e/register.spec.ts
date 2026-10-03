/**
 * E2E — a participant registering their team (E44).
 *
 * Walked with the link planted by the seed, because nothing is transmitted in test. What the
 * journey proves: the screen never shows a list of participants, the count is the signal, the
 * confirm button says why it is disabled, and the code is never on the screen.
 */
import { expect, test } from '@playwright/test'
import { E2E_LINK, seedRegistration } from './support/registrationSeed.js'

test.beforeEach(async () => { await seedRegistration() })

test.describe('starting', () => {
  test('is reachable without signing in, and says plainly when an address is unknown', async ({ page }) => {
    await page.goto('/register')
    await expect(page.getByRole('heading', { name: 'Register your team' })).toBeVisible()

    await page.getByLabel('Your email').fill('nobody@example.test')
    await page.getByRole('button', { name: 'Send me the link' }).click()
    await expect(page.getByRole('alert')).toContainText(/not on the participant list/)
  })

  test('confirms a link was sent without showing it', async ({ page }) => {
    await page.goto('/register')
    await page.getByLabel('Your email').fill('grace@example.test')
    await page.getByRole('button', { name: 'Send me the link' }).click()

    // With the recording provider the message is composed and not transmitted; the screen still
    // says a link was sent, because from the participant's side that is what happened.
    await expect(page.getByTestId('link-sent')).toContainText(/emailed/)
    await expect(page.locator('body')).not.toContainText('crr_')
  })
})

test.describe('with a link', () => {
  test('builds a team by exact address, never from a list, and registers it', async ({ page }) => {
    await page.goto(`/register?link=${E2E_LINK}`)

    await expect(page.getByText(/Registering as/)).toContainText('Ada Lovelace')
    await expect(page.getByTestId('member-count')).toHaveText('1')
    // No dropdown at all (II.1). The challenge select moved to the submission form, where a
    // team knows which path it took; at registration, half an hour before coding starts, the
    // answer was a guess.
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.getByText('Grace Hopper')).toHaveCount(0)

    await page.getByLabel('Team name').fill('Night Shift')
    await expect(page.getByRole('status').filter({ hasText: 'Available.' })).toBeVisible()

    const box = page.getByLabel(/Add a teammate by email/)
    await box.fill('grace@example.test')
    await box.press('Enter')
    await expect(page.getByRole('list', { name: 'Team members' })).toContainText('Grace Hopper')
    await box.fill('nobody@example.test')
    await box.press('Enter')
    await expect(page.getByRole('alert')).toContainText(/No participant with that address/)
    await box.fill('alan@example.test')
    await box.press('Enter')
    await expect(page.getByTestId('member-count')).toHaveText('3')

    await page.getByRole('button', { name: 'Register the team' }).click()

    await expect(page.getByTestId('registered')).toContainText('Night Shift is registered')
    await expect(page.getByTestId('registered')).toContainText('3 members')
    // The code is NEVER on this screen.
    await expect(page.locator('body')).not.toContainText('crs_')
  })

  test('will not register two people, and says what is missing', async ({ page }) => {
    await page.goto(`/register?link=${E2E_LINK}`)
    await page.getByLabel('Team name').fill('Pair')
    const box = page.getByLabel(/Add a teammate by email/)
    await box.fill('grace@example.test')
    await box.press('Enter')
    await expect(page.getByTestId('member-count')).toHaveText('2')

    await expect(page.getByRole('button', { name: 'Register the team' })).toBeDisabled()
    await expect(page.getByText(/add 1 more teammate/)).toBeVisible()
  })

  test('a spent or unknown link says so rather than showing a blank form', async ({ page }) => {
    await page.goto('/register?link=crr_not-a-real-link-000000000000')
    await expect(page.getByText('This link cannot be used')).toBeVisible()
  })
})

test.describe('the Discord identity (E49-S02)', () => {
  test('is not asked for when Discord delivery is not configured', async ({ page }) => {
    await page.goto(`/register?link=${E2E_LINK}`)
    await expect(page.getByText(/Registering as/)).toContainText('Ada Lovelace')
    await expect(page.getByLabel('Team name')).toBeVisible()
    // Nobody is asked for what cannot be used: the field exists only with a bot configured.
    await expect(page.getByLabel(/Discord username/)).toHaveCount(0)
  })

  test('is not asked of a TEAMMATE either when it is not configured', async ({ page }) => {
    // Every member gained a box under migration 100, and every one of them has to disappear
    // on a deployment with no bot — not just the registrant's.
    await page.goto(`/register?link=${E2E_LINK}`)
    const box = page.getByLabel(/Add a teammate by email/)
    await box.fill('grace@example.test')
    await box.press('Enter')
    await expect(page.getByTestId('member-count')).toHaveText('2')
    await expect(page.getByLabel(/Discord username for/)).toHaveCount(0)
  })
})
