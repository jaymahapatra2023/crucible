/**
 * E2E — the public "Check your details" page (migration 104).
 *
 * It is the third screen a participant can reach without an account, and the only one that
 * accepts a change to the roster. What is tested here is that it gives nothing away: the same
 * answer for a name that is on the list and one that is not, and no record on screen either way.
 */
import { expect, test } from '@playwright/test'

test.describe('checking your details', () => {
  test('is reachable without signing in, from the public navigation', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Check details' })).toBeVisible()
    await page.getByRole('link', { name: 'Check details' }).click()
    await expect(page.getByRole('heading', { name: 'Check your details' })).toBeVisible()
  })

  test('will not send an incomplete claim', async ({ page }) => {
    await page.goto('/confirm')
    const send = page.getByRole('button', { name: 'Send this to an organiser' })
    await expect(send).toBeDisabled()

    await page.getByLabel(/Your full name/).fill('Ada Lovelace')
    await expect(send).toBeDisabled()          // still no address
    await page.getByLabel(/Your email/).fill('not-an-email')
    await expect(send).toBeDisabled()          // and not one that could work
    await page.getByLabel(/Your email/).fill('ada@example.test')
    await expect(send).toBeEnabled()
  })

  test('answers a name on the list and one that is not with the SAME words', async ({ page }) => {
    await page.goto('/confirm')
    await page.getByLabel(/Your full name/).fill('Ada Lovelace')
    await page.getByLabel(/Your email/).fill('ada@example.test')
    await page.getByRole('button', { name: 'Send this to an organiser' }).click()
    const onList = await page.getByTestId('confirm-sent').textContent()

    await page.goto('/confirm')
    await page.getByLabel(/Your full name/).fill('Nobody Whatsoever')
    await page.getByLabel(/Your email/).fill('nobody@example.test')
    await page.getByRole('button', { name: 'Send this to an organiser' }).click()
    const notOnList = await page.getByTestId('confirm-sent').textContent()

    expect(onList).toBe(notOnList)
  })

  test('shows no record back — not a name, not an address, not a team', async ({ page }) => {
    await page.goto('/confirm')
    await page.getByLabel(/Your full name/).fill('Ada Lovelace')
    await page.getByLabel(/Your email/).fill('ada@example.test')
    await page.getByRole('button', { name: 'Send this to an organiser' }).click()

    const body = await page.locator('main').textContent()
    expect(body).not.toMatch(/@example\.test/)
    expect(body).not.toMatch(/Lovelace/)
  })
})
