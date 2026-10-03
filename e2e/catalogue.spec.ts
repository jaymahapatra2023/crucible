/**
 * E2E — writing the principles and standards an evaluation judges against (E12).
 *
 * The journey a platform owner takes before any challenge runs: write down what the organisation
 * requires, and choose what is assessed against. The distinction the whole page turns on is that
 * those are two separate acts — writing one down does not start scoring teams on it.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

const uniqueCode = () => `E2E_${Date.now().toString(36).toUpperCase()}`

/**
 * The open editor.
 *
 * Scoped to the form rather than the page: the catalogue list behind it carries checkboxes
 * labelled "Assess submissions against …", and an unscoped `getByLabel('Code')` matches the one
 * whose principle name happens to end in "code".
 */
const editor = (page: Page) => page.locator('form')

async function fillPrinciple(page: Page, code: string) {
  const form = editor(page)
  await form.getByLabel('Code').fill(code)
  await form.getByLabel('Pillar').selectOption({ index: 1 })
  await form.getByLabel('Name').fill('Evidence over assertion')
  await form.getByLabel('Description').fill(
    'Every claim a service makes about itself is checkable against something it stores.')
  await form.getByLabel('What a reader should be able to point at').fill(
    'Audit records, persisted decisions, and the queries that read them back.')
  for (let i = 0; i < 5; i++) {
    await form.getByLabel(`Level ${i}`).fill(`Level ${i} looks like this, distinctly.`)
  }
}

test.beforeAll(async () => { await seedE2EUsers() })

test.describe('the catalogue', () => {
  test('is reachable from the primary navigation', async ({ page }) => {
    await signIn(page)
    await page.getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Principles' }).click()
    await expect(page.getByRole('heading', { name: 'Principles and standards' })).toBeVisible()
  })

  test('says what is adopted, because only adopted entries are assessed', async ({ page }) => {
    await signIn(page)
    await page.goto('/catalogue')
    await expect(
      page.getByText(/adopted\. Only adopted entries are assessed against\.|Nothing in this list is adopted/),
    ).toBeVisible()
  })
})

test.describe('writing a principle', () => {
  test('adds it to the catalogue without starting to score teams on it', async ({ page }) => {
    const code = uniqueCode()
    await signIn(page)
    await page.goto('/catalogue')

    await page.getByRole('button', { name: 'Add a principle' }).click()
    await fillPrinciple(page, code)
    await page.getByRole('button', { name: 'Save principle' }).click()

    await expect(page.getByRole('status'))
      .toContainText('not assessed against until you adopt it')
    // And it is in the list, unadopted.
    const row = page.locator('article', { hasText: code })
    await expect(row).toBeVisible()
    await expect(row.getByRole('checkbox')).not.toBeChecked()
  })

  test('refuses an evidence specification too vague to select source by', async ({ page }) => {
    await signIn(page)
    await page.goto('/catalogue')

    await page.getByRole('button', { name: 'Add a principle' }).click()
    await fillPrinciple(page, uniqueCode())
    await editor(page).getByLabel('What a reader should be able to point at').fill('good code')
    await page.getByRole('button', { name: 'Save principle' }).click()

    await expect(page.getByRole('alert')).toContainText('specific enough to select source by')
  })

  test('refuses two anchors that say the same thing', async ({ page }) => {
    await signIn(page)
    await page.goto('/catalogue')

    await page.getByRole('button', { name: 'Add a principle' }).click()
    await fillPrinciple(page, uniqueCode())
    await editor(page).getByLabel('Level 2').fill('Level 1 looks like this, distinctly.')
    await page.getByRole('button', { name: 'Save principle' }).click()

    await expect(page.getByRole('alert')).toContainText('say the same thing')
  })

  test('adopting it says plainly what has changed', async ({ page }) => {
    const code = uniqueCode()
    await signIn(page)
    await page.goto('/catalogue')

    await page.getByRole('button', { name: 'Add a principle' }).click()
    await fillPrinciple(page, code)
    await page.getByRole('button', { name: 'Save principle' }).click()

    // `click`, not `check`: the control is not optimistic — it reflects the server's answer
    // after the round trip, so asserting on its state immediately would assert on a lie.
    const row = page.locator('article', { hasText: code })
    await row.getByRole('checkbox').click()
    await expect(page.getByRole('status')).toContainText(`${code} is now adopted.`)
    await expect(page.locator('article', { hasText: code }).getByRole('checkbox')).toBeChecked()
  })
})

test.describe('writing a standard', () => {
  test('captures scope, so an inapplicable standard is not a failure', async ({ page }) => {
    const code = uniqueCode()
    await signIn(page)
    await page.goto('/catalogue')

    await page.getByRole('tab', { name: /standards/i }).click()
    await page.getByRole('button', { name: 'Add a standard' }).click()

    const form = editor(page)
    await form.getByLabel('Code').fill(code)
    await form.getByLabel('Category').selectOption({ index: 1 })
    await form.getByLabel('Name').fill('Dependencies are pinned')
    await form.getByLabel('What the standard requires').fill(
      'Every dependency resolves to an exact version rather than a range.')
    await form.getByLabel('What a reader should be able to point at').fill(
      'Lockfiles, version ranges in manifests, and the CI install step.')
    await form.getByLabel('Applies to').fill('node, python')

    await expect(page.getByText(/marked not applicable, rather than non-compliant/i)).toBeVisible()
    await page.getByRole('button', { name: 'Save standard' }).click()

    await expect(page.locator('article', { hasText: code })).toBeVisible()
  })
})
