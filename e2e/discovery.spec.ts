/**
 * E2E — a reviewer reading what a team actually built (E12).
 *
 * The promise this page makes, and the only reason it is worth the seven model calls: every
 * number on it is a count of rows the reviewer can scroll to and check, and a concern that
 * could not be read says so instead of showing a zero.
 *
 * The fixture is deliberately mixed. One concern found nothing and means it; another could not
 * be read at all. If the page renders those two the same way, a reviewer will read our failure
 * as the team's omission, and these tests exist to make that impossible to ship.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun, type SeededScoring } from './support/scoringSeed.js'
import { clearDiscovery, seedDiscovery } from './support/discoverySeed.js'

let seeded: SeededScoring
let submissionId: number

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => { await seedE2EUsers() })

test.beforeEach(async () => {
  seeded = await seedScoredRun()
  submissionId = seeded.submissionIds[0]!
  await seedDiscovery(submissionId)
})

test.describe('reading a discovery', () => {
  test('presents itself as a description, not a score', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await expect(page.getByRole('heading', { name: 'What this team built' })).toBeVisible()
    await expect(page.getByText(/A description, not a score/)).toBeVisible()
  })

  test('shows a count where a count is true, and words where it is not', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    // Found two endpoints, read the code and found no integrations, could not read the stack.
    const tiles = page.getByRole('list', { name: 'What discovery found' })
    await expect(tiles.getByRole('button', { name: /API endpoints/ })).toContainText('2')
    await expect(tiles.getByRole('button', { name: /Integrations/ })).toContainText('0')

    const stack = tiles.getByRole('button', { name: /Stack components/ })
    await expect(stack).toContainText('Not determined')
    await expect(stack).toContainText('not a zero')
    await expect(stack).not.toContainText('0')
  })

  test('warns at the top that part of the description is missing', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    const note = page.getByRole('note')
    await expect(note).toContainText('could not be determined')
    await expect(note).toContainText('No manifest or build file')
    await expect(note).toContainText('Nothing is scored down for them')
  })

  test('shows every finding with the file and line it came from', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await page.getByRole('button', { name: /API endpoints/ }).click()
    await expect(page.getByText('GET /api/teams')).toBeVisible()
    await expect(page.getByText('src/routes/teams.ts:12–18')).toBeVisible()
  })

  test('shows an endpoint whose auth could not be determined as UNKNOWN', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await page.getByRole('button', { name: /API endpoints/ }).click()
    // Guessing NONE would invent a security finding; guessing REQUIRED would hide one.
    await expect(page.getByText('UNKNOWN')).toBeVisible()
  })

  test('shows the data model as a readable field table', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await page.getByRole('button', { name: /Data entities/ }).click()
    const row = page.getByRole('row', { name: /challenge_id/ })
    await expect(row).toContainText('FOREIGN')
    await expect(row).toContainText('challenge')
  })

  test('labels a security finding by concern and offers what would clear it', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await page.getByRole('button', { name: /Security observations/ }).click()
    await expect(page.getByText(/Concern if confirmed/)).toBeVisible()
    await expect(page.getByText(/Check this first/)).toBeVisible()
    await expect(page.getByText(/validate the name against an allow-list/)).toBeVisible()
  })

  test('states a concern it could not read rather than listing nothing', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    // Clicking the tile opens the matching section, which is how a reviewer gets there.
    await page.getByRole('button', { name: /Stack components/ }).click()
    await expect(page.getByText('This could not be determined from what was read.')).toBeVisible()
    await expect(page.getByText(/not a statement that the submission has none of these/))
      .toBeVisible()
  })
})

test.describe('documentation against code', () => {
  test('frames a conflict as worth checking, never as dishonesty', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await expect(page.getByText('Worth checking')).toBeVisible()
    await expect(page.getByText(/not findings of fact and certainly not findings of dishonesty/i))
      .toBeVisible()
  })

  test('shows the innocent explanation alongside the observation', async ({ page }) => {
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await expect(page.getByText(/could still be explained by/)).toBeVisible()
    await expect(page.getByText(/outside what the scan read/)).toBeVisible()
  })
})

test.describe('a submission nobody has described', () => {
  test('offers to run discovery rather than showing an empty description', async ({ page }) => {
    await clearDiscovery()
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await expect(page.getByText('This submission has not been described yet')).toBeVisible()
    await expect(page.getByRole('button', { name: /Run discovery/ })).toBeVisible()
    // Nothing on the page may read as a finding about the submission.
    await expect(page.getByRole('list', { name: 'What discovery found' })).toHaveCount(0)
  })

  test('says that nothing runs discovery automatically', async ({ page }) => {
    await clearDiscovery()
    await signIn(page)
    await page.goto(`/submissions/${submissionId}/discovery`)

    await expect(page.getByText(/nothing runs it automatically/)).toBeVisible()
  })
})

test.describe('reaching it from a review', () => {
  test('a reviewer can open the description from the team page', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${submissionId}`)

    await page.getByRole('link', { name: /What this team built/ }).click()
    await expect(page).toHaveURL(new RegExp(`/submissions/${submissionId}/discovery$`))
    await expect(page.getByRole('heading', { name: 'What this team built' })).toBeVisible()
  })
})
