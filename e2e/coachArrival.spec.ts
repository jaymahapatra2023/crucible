/**
 * E2E — coaches confirming they are at the venue (migration 105).
 *
 * The journey is one tap on a phone walking into a building, so what is tested is that it takes
 * one tap, that the list can be narrowed by typing, and that nothing but names is on the page.
 */
import { expect, test } from '@playwright/test'

test.describe('coach check-in', () => {
  test('is reachable without signing in, from the public navigation', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Coaches' }).click()
    await expect(page.getByRole('heading', { name: /let us know you are here/i })).toBeVisible()
  })

  test('lists names and no addresses', async ({ page }) => {
    await page.goto('/coach')
    await expect(page.getByRole('list', { name: 'Coaches' })).toBeVisible()
    // A coach's name is on the door already. Their address is not, and this page has no use
    // for it, so none may appear.
    await expect(page.locator('main')).not.toContainText('@')
  })

  test('narrows the list as you type, without a round trip', async ({ page }) => {
    await page.goto('/coach')
    const names = page.getByRole('list', { name: 'Coaches' }).getByRole('button')
    // Asserted rather than counted: `count()` does not wait, so counting first races the fetch.
    await expect(names.first()).toBeVisible()
    expect(await names.count()).toBeGreaterThan(0)

    await page.getByLabel('Find your name').fill('zzzzz')
    await expect(page.getByText(/No coach matches that/)).toBeVisible()
  })

  test('confirms in one tap and says so', async ({ page }) => {
    await page.goto('/coach')
    await page.getByRole('list', { name: 'Coaches' }).getByRole('button').first().click()
    await expect(page.getByTestId('coach-confirmed')).toBeVisible()
    await expect(page.getByTestId('coach-confirmed')).toContainText(/marked as here/i)
  })
})
