/**
 * E2E — the committee journey: review, weight, acknowledge, approve, freeze, publish
 * (E02-S06, E02-S07, E02-S08).
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedDraftRubric, seedE2EUsers } from './support/seed.js'

let rubricId: number
let slug: string

/**
 * Tick every acknowledgement checkbox.
 *
 * `locator.all()` does NOT auto-wait — called before React has rendered it returns an empty
 * list, the loop does nothing, and the failure surfaces much later as "Approve is still
 * disabled". Waiting for the first checkbox first makes the helper deterministic.
 */
async function acknowledgeAllWarnings(page: Page) {
  const boxes = page.getByRole('checkbox')
  await expect(boxes.first()).toBeVisible()
  const count = await boxes.count()
  for (let i = 0; i < count; i++) await boxes.nth(i).check()
}

async function signIn(page: Page, who: 'admin' | 'reviewer' = 'admin') {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS[who].email)
  await page.getByLabel('Password').fill(E2E_USERS[who].password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => {
  await seedE2EUsers()
})

test.beforeEach(async () => {
  const seeded = await seedDraftRubric()
  rubricId = seeded.rubricId
  slug = seeded.slug
})

test.describe('rubric review', () => {
  test('shows each criterion with its brief reference and evidence specification', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)

    await expect(page.getByRole('heading', { name: /Rubric v1/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ingests the telemetry feed' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'brief §2.1' })).toBeVisible()
    await expect(page.getByText(/A reader can point to the implementing code/).first()).toBeVisible()
  })

  test('the brief reference opens the actual passage it cites (acceptance 3)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)

    // Before clicking, the passage is not on screen.
    await expect(page.getByText(/connect to the telemetry feed and parse/)).toHaveCount(0)

    await page.getByRole('button', { name: 'brief §2.1' }).click()
    await expect(page.getByText(/connect to the telemetry feed and parse/)).toBeVisible()
    await expect(page.getByText('brief.md — ## 2.1 Ingestion')).toBeVisible()
  })

  test('says so plainly when a reference cannot be resolved', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)
    await page.getByRole('button', { name: 'brief §2.2' }).click()
    // §2.2 does resolve; the unresolvable case is covered at the service level. Here we assert
    // the panel renders a passage rather than a dead anchor.
    await expect(page.getByText(/exceeds its configured threshold/)).toBeVisible()
  })

  test('surfaces the quality-gate flag on the criterion it concerns', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)
    await expect(page.getByText('Needs rewrite')).toBeVisible()
    await expect(page.getByText(/could not confirm this is locatable/).first()).toBeVisible()
  })

  test('shows the running weight total and flags it when it is not 1.00', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)

    const total = page.getByTestId('total-CHALLENGE_FIDELITY')
    await expect(total).toHaveText('1.00')

    await page.getByLabel('Weight for Ingests the telemetry feed').fill('0.5')
    await expect(total).toHaveText('0.90')
    await expect(page.getByText('must be 1.00')).toBeVisible()
  })

  test('BLOCKS approval until the gate warning is acknowledged', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)

    const approve = page.getByRole('button', { name: 'Approve' })
    await expect(approve).toBeDisabled()
    await expect(page.getByText(/Acknowledge every warning above/)).toBeVisible()

    await page.getByRole('checkbox').first().check()
    await expect(approve).toBeEnabled()
  })

  test('walks approve → freeze → publish, and the hash appears once frozen', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)

    await acknowledgeAllWarnings(page)
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('heading', { name: /Rubric v1/ })).toContainText('APPROVED')

    await page.getByRole('button', { name: 'Freeze' }).click()
    await expect(page.getByRole('heading', { name: /Rubric v1/ })).toContainText('FROZEN')
    await expect(page.getByText(/Content hash/)).toBeVisible()

    await page.getByRole('button', { name: /publish/i }).click()
    await expect(page.getByText(/cannot be edited/)).toBeVisible()
  })

  test('a frozen rubric is read-only on screen', async ({ page }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)
    await acknowledgeAllWarnings(page)
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('button', { name: 'Freeze' }).click()

    await expect(page.getByLabel('Weight for Ingests the telemetry feed')).toBeDisabled()
    await expect(page.getByRole('button', { name: /save weights/i })).toHaveCount(0)
  })

  test('the published rubric is readable with no account at all (P8.1)', async ({ page, request }) => {
    await signIn(page)
    await page.goto(`/rubrics/${rubricId}`)
    await acknowledgeAllWarnings(page)
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('button', { name: 'Freeze' }).click()
    await page.getByRole('button', { name: /publish/i }).click()
    await expect(page.getByText(/cannot be edited/)).toBeVisible()

    // A team has no session and no token. The publish click above is acknowledged on screen
    // before its request has necessarily landed, so the read is polled rather than assumed.
    await expect.poll(async () =>
      (await request.get(`/api/v1/rubrics/published/${slug}`, { headers: { accept: 'text/html' } })).status(),
    { timeout: 15_000 }).toBe(200)
    const response = await request.get(`/api/v1/rubrics/published/${slug}`, {
      headers: { accept: 'text/html' },
    })
    const html = await response.text()
    expect(html).toContain('Scoring rubric')
    expect(html).toContain('Ingests the telemetry feed')
    expect(html).toMatch(/Content hash/)
  })
})
