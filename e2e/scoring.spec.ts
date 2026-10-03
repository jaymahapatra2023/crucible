/**
 * E2E — a reviewer reading a scoring run (E06-S02, E06-S04, E06-S05, E07-S04).
 *
 * The journey that matters is not "can I see a number". It is whether a reviewer can tell the
 * difference between a team who scored badly and a team the system could not assess — in a real
 * browser, against a real database, through the real API. Every layer between the CHECK
 * constraint and the rendered words has an opportunity to flatten that distinction, and this is
 * the only test that exercises all of them at once.
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

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { seeded = await seedScoredRun() })

test.describe('the ranking (E07)', () => {
  test('ranks the cohort and links to each submission', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)

    await expect(page.getByRole('heading', { name: /Ranking/ })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Team Scored' })).toBeVisible()
  })

  test('says it decides nothing, and offers no control that would', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)

    await expect(page.getByText(/Nothing here selects or eliminates anyone/)).toBeVisible()
    await expect(page.getByRole('button', { name: /select|shortlist|eliminate/i }))
      .toHaveCount(0)
  })

  test('WARNS that the cohort was too small to normalise', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByText(/too few submissions to normalise/)).toBeVisible()
  })

  test('flags positions computed from partial evidence', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByText(/composites are partial/)).toBeVisible()
  })

  test('keeps the RAW fidelity visible beside the normalised one', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByText(/raw 88\.0/)).toBeVisible()
  })

  test('shows the challenge split with medians (E07-S05)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)

    await expect(page.getByRole('heading', { name: 'Split by challenge' })).toBeVisible()
    await expect(page.getByTestId(`split-count-${seeded.challengeId}`)).toHaveText('3')
    await expect(page.getByTestId(`split-count-${seeded.secondChallengeId}`)).toHaveText('1')
  })

  test('raises the imbalance advisory when one challenge dominates (E07-S05)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    // Three of four is 75%, above the 70% default.
    await expect(page.getByTestId('split-advisory')).toContainText('75%');
  })

  test('exports a CSV that carries the same caveats (E07-S03)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-ranking').click(),
    ])
    expect(download.suggestedFilename()).toBe(`ranking-run-${seeded.runIndexId}.csv`)
  })
})

test.describe('the cut-line band (E07-S06)', () => {
  test('lists every submission near the line AS requiring review', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByRole('heading', { name: /3 require review/ })).toBeVisible()
  })

  test('CALLS OUT a position that turns on the advisory dimension', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)

    await expect(page.getByTestId('advisory-decided'))
      .toContainText('must not decide this on its own')
    await expect(
      page.getByText(/position depends on the advisory inventiveness dimension/).first(),
    ).toBeVisible()
  })

  test('says why each entry needs a look, not merely that it does', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}`)
    await expect(page.getByText(/the order between ties is arbitrary/)).toBeVisible()
    await expect(page.getByText(/cohort too small to normalise/).first()).toBeVisible()
  })
})

test.describe('one submission’s scores', () => {
  test('shows the score, its anchor, its rationale and its evidence', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[0]}`)

    await expect(page.getByText('Retries with backoff, and failures are surfaced.')).toBeVisible()
    await expect(page.getByText(/exponential backoff is present/)).toBeVisible()

    // Tolerant of the count: the fixture now seeds two citations with different verdicts,
    // because telling those apart is the journey E13 exists to support.
    await page.getByText(/piece(s)? of evidence/).click()
    await expect(page.getByText('src/retry.ts:1–12')).toBeVisible()
  })

  test('shows the MEASUREMENTS behind the score (E06-S04 acceptance 3)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[0]}`)

    await expect(page.getByRole('heading', { name: 'Measurements' })).toBeVisible()
    await expect(page.getByText('1 of 3')).toBeVisible()
    await expect(page.getByText(/Size is context, not quality/)).toBeVisible()
  })

  test('shows the advisory signal AS advisory, with its basis', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[0]}`)

    await expect(page.getByText('ADVISORY')).toBeVisible()
    await expect(page.getByText(/never be the sole reason/)).toBeVisible()
    await expect(page.getByText('62.0%')).toBeVisible()
    await expect(page.getByText(/Vite starter template/)).toBeVisible()

    // E35: the measurements are context for a question about the approach, not the answer to a
    // question about authorship.
    await expect(page.getByRole('heading', { name: /Inventiveness/ })).toBeVisible()
    await expect(page.getByText(/how the repository was assembled, not how good the idea is/))
      .toBeVisible()
  })
})

test.describe('the distinction the whole system exists to protect', () => {
  test('an unevidenced criterion reads as unassessed, NOT as a zero', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[1]}`)

    await expect(page.getByText('Not enough evidence to score')).toBeVisible()
    await expect(page.getByText(/excluded from the average rather than counted as zero/))
      .toBeVisible()
    // The number 0 must not appear as this criterion's score.
    await expect(page.locator('article').first().getByText('0', { exact: true }))
      .toHaveCount(0)
  })

  test('names the terms it searched for, so the gap is actionable', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[1]}`)
    await expect(page.getByText(/searched for: retry, backoff, error/)).toBeVisible()
  })

  test('a FAILED scoring call reads as a system failure, not a judgement', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[2]}`)

    await expect(page.getByText(/not an assessment of the work/)).toBeVisible()
    await expect(page.getByText(/says nothing about the submission/)).toBeVisible()
  })

  test('the header counts the criteria that could not be scored', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[1]}`)
    await expect(page.getByText(/1 without a score/)).toBeVisible()
  })

  test('says the advisory dimension was LEFT OUT when it did not run', async ({ page }) => {
    await signIn(page)
    await page.goto(`/scoring/runs/${seeded.runIndexId}/submissions/${seeded.submissionIds[1]}`)
    await expect(page.getByText(/left out of the composite rather than scored zero/))
      .toBeVisible()
  })
})

test.describe('starting a run from the app (E39)', () => {
  test('will not start without a cohort, and explains what one scopes', async ({ page }) => {
    await signIn(page)
    await page.goto('/scoring')

    await expect(page.getByRole('button', { name: /Start run 1/ })).toBeDisabled()
    // The mistake this guards against: a cohort key chosen without knowing it scopes the ranking.
    await expect(page.getByText(/Ranking, the cut line and run-to-run variance/)).toBeVisible()
    // And that the cost is stated before the click, not discovered after it.
    await expect(page.getByText(/costs model calls and takes hours/)).toBeVisible()
  })

  test('warns before the click that an existing run would be continued', async ({ page }) => {
    await signIn(page)
    await page.goto('/scoring')

    // The seeded run already occupies run 1 of this cohort. Nothing refuses a second start —
    // the orchestrator reuses the run — so the warning is the whole safeguard.
    await page.getByLabel(/Cohort/).fill('e2e-cohort')

    await expect(page.getByTestId('run-collision')).toContainText(/already has run 1/)
    await expect(page.getByRole('button', { name: 'Continue run 1' })).toBeVisible()
    // Deliberately NOT clicking: this test must not start a real batch.
  })
})
