/**
 * E2E — a reviewer telling a checked citation from an unchecked one (E13-S04).
 *
 * This is where the whole feature either pays off or does not. A reviewer in the cut band, under
 * time pressure, is not going to open the file. What they see beside the quotation is, in
 * practice, the entire strength of the evidence — so it has to be right, and it has to be in
 * words rather than a colour.
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

async function openEvidence(page: Page) {
  await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)
  await page.getByText(/piece(s)? of evidence/).first().click()
}

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { seeded = await seedScoredRun() })

test.describe('citations a reviewer can weigh', () => {
  test('says which quotation was checked against the submitted commit', async ({ page }) => {
    await signIn(page)
    await openEvidence(page)
    await expect(page.getByText('checked against the source')).toBeVisible()
  })

  test('says which one could not be checked, and frames it as our limit', async ({ page }) => {
    await signIn(page)
    await openEvidence(page)

    await expect(page.getByText('outside what the scan read')).toBeVisible()
    // Nothing anywhere may suggest the team invented it.
    await expect(page.locator('body')).not.toContainText(/fabricat|invented|suspicious/i)
  })

  test('distinguishes the two in words, not by colour alone', async ({ page }) => {
    await signIn(page)
    await openEvidence(page)

    // Both labels present and different: a reviewer who cannot see colour still reads the
    // distinction (P5.5).
    await expect(page.getByText('checked against the source')).toBeVisible()
    await expect(page.getByText('outside what the scan read')).toBeVisible()
  })

  test('carries the reason without crowding the page', async ({ page }) => {
    await signIn(page)
    await openEvidence(page)
    await expect(page.getByText('checked against the source'))
      .toHaveAttribute('title', /src\/retry\.ts/)
  })
})

test.describe('the appeal packet', () => {
  test('tells the team how much of the cited evidence was checked', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: /evaluation record|appeal/i }).first().click()
    const file = await download
    const stream = await file.createReadStream()
    const text = await new Promise<string>((resolve, reject) => {
      let out = ''
      stream.on('data', (c) => { out += String(c) })
      stream.on('end', () => resolve(out))
      stream.on('error', reject)
    })

    expect(text).toMatch(/were found in the commit you submitted/i)
    expect(text).toMatch(/a limit of our reading, not a doubt about your work/i)
    // Codes a reader would have to look up have no place in a document for a team.
    expect(text).not.toMatch(/\bUNVERIFIABLE\b/)
  })
})
