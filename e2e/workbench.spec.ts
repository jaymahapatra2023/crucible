/**
 * E2E — the committee doing the two jobs the system asks of them (E18).
 *
 * Rewriting a criterion the quality gate flagged, and assembling the evidence the go/no-go gate
 * rests on. Both existed as API and nowhere else, which made the most consequential decision in
 * this system the least accessible one.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun } from './support/scoringSeed.js'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

/** A draft rubric, since a frozen one refuses every edit by design. */
async function openDraftRubric(page: Page) {
  await page.goto('/challenges')
  await page.getByRole('row', { name: /Scoring Challenge/ })
    .getByRole('link', { name: /^v\d+$/ }).click()
  await page.getByRole('button', { name: /Create a new version from this one/ }).click()
  await expect(page.getByRole('heading', { name: /Rubric v2/ })).toBeVisible()
}

test.beforeAll(async () => { await seedE2EUsers() })
// The seeded run is a precondition, not a handle: every assertion below reaches it through the
// UI, so nothing here needs its ids.
test.beforeEach(async () => { await seedScoredRun() })

test.describe('rewriting a criterion (E18-S01)', () => {
  test('offers no edit on a frozen rubric', async ({ page }) => {
    await signIn(page)
    await page.goto('/challenges')
    await page.getByRole('row', { name: /Scoring Challenge/ })
      .getByRole('link', { name: /^v\d+$/ }).click()

    await expect(page.getByRole('button', { name: /^Edit$/ })).toHaveCount(0)
  })

  test('opens an editor on a draft, with the anchors in it', async ({ page }) => {
    await signIn(page)
    await openDraftRubric(page)

    await page.getByRole('button', { name: /^Edit$/ }).first().click()
    await expect(page.getByLabel(/Level 0/)).toBeVisible()
    await expect(page.getByLabel(/What a reader should be able to point at/)).toBeVisible()
  })

  test('REFUSES an evidence specification too vague to select source by', async ({ page }) => {
    await signIn(page)
    await openDraftRubric(page)
    await page.getByRole('button', { name: /^Edit$/ }).first().click()

    await page.getByLabel(/What a reader should be able to point at/).fill('good code')
    await page.getByRole('button', { name: /save criterion/i }).click()

    await expect(page.getByRole('alert'))
      .toContainText(/specific enough to select source by/i)
  })

  test('saves a rewritten criterion and shows it', async ({ page }) => {
    await signIn(page)
    await openDraftRubric(page)
    await page.getByRole('button', { name: /^Edit$/ }).first().click()

    await page.getByLabel('Name', { exact: false }).first()
      .fill('Recovers from failure without losing work')
    await page.getByRole('button', { name: /save criterion/i }).click()

    await expect(page.getByRole('heading', { name: 'Recovers from failure without losing work' }))
      .toBeVisible()
  })
})

/** A golden set exists only once one is created; the page shows an empty state otherwise. */
async function newGoldenSet(page: Page) {
  await page.goto('/calibration')
  await page.getByRole('button', { name: /new golden set/i }).first().click()
  await page.locator('form').getByLabel('Name').fill('Autumn rehearsal')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await expect(page.getByTestId('set-readiness')).toBeVisible()
}

test.describe('linking a golden set to what was scored (E21)', () => {
  test('says no report is possible until every entry is linked', async ({ page }) => {
    await signIn(page)
    await newGoldenSet(page)

    await expect(page.getByRole('heading', { name: /Link entries to what was scored/ }))
      .toBeVisible()
    await expect(page.getByText(/No report can be produced until every entry is linked/))
      .toBeVisible()
  })

  test('reports an entry nothing was submitted for, rather than failing at the report', async ({ page }) => {
    // The defect this closes: the report refused with a message about the RUN, which is a long
    // way from the entry that actually has nothing behind it.
    await signIn(page)
    await newGoldenSet(page)

    await page.getByLabel('Label').fill('Unsubmitted repo')
    await page.getByLabel('Repository URL').fill('https://github.com/golden/never-submitted')
    await page.getByRole('button', { name: /Add to the set/ }).click()

    await page.getByRole('button', { name: 'Check what matches' }).click()

    const table = page.getByRole('table', { name: /entries in this set/i })
    await expect(table.getByText('never submitted')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Link 1 entry/ })).toBeDisabled()
  })
})

test.describe('the calibration workbench (E18-S02 … S04)', () => {
  test('is reachable from the primary navigation', async ({ page }) => {
    await signIn(page)
    await page.getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Calibration' }).click()
    await expect(page.getByRole('heading', { name: 'Calibration', level: 1 })).toBeVisible()
  })

  test('explains what a golden set is for when there is none', async ({ page }) => {
    await signIn(page)
    await page.goto('/calibration')
    await expect(page.getByText(/ranked by hand before any machine sees them/i)).toBeVisible()
  })

  test('shows a thin set as not ready, naming what is missing', async ({ page }) => {
    await signIn(page)
    await page.goto('/calibration')

    await page.getByRole('button', { name: /new golden set/i }).first().click()
    await page.locator('form').getByLabel('Name').fill('Autumn rehearsal')
    await page.getByRole('button', { name: /^Create$/ }).click()

    await expect(page.getByTestId('set-readiness')).toContainText(/Not yet ready to seal/i)
    await expect(page.getByTestId('set-readiness')).toContainText(/of 8 repositories/)
    await expect(page.getByRole('button', { name: /seal the set/i })).toBeDisabled()
  })

  test('records gate criteria before any report exists, and says why', async ({ page }) => {
    await signIn(page)
    await page.goto('/calibration')

    await page.getByRole('button', { name: /new golden set/i }).first().click()
    await page.locator('form').getByLabel('Name').fill('Autumn rehearsal')
    await page.getByRole('button', { name: /^Create$/ }).click()

    await expect(
      page.getByText(/criteria written afterwards describe whatever the report happened to say/i),
    ).toBeVisible()
    await page.getByRole('button', { name: /record these criteria/i }).click()
    await expect(page.getByTestId('criteria-recorded')).toBeVisible()
    await expect(page.getByText(/before any report existed/i)).toBeVisible()
  })
})
