/**
 * E2E — a reviewer working through the ranked field (E08).
 *
 * The journey the whole system exists to support: read the field, open a borderline team, see
 * why it scored as it did, set a caveat aside with a reason, record a decision, and lock the
 * result. Every step of it is meant to be defensible afterwards, and this is the only test that
 * exercises the whole chain — schema constraint to rendered sentence — at once.
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

test.describe('the ranked field (E08-S01, E08-S06)', () => {
  test('shows the field with backend counts, not the row count', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await expect(page.getByRole('heading', { name: /Review · run/ })).toBeVisible()
    await expect(page.getByTestId('showing-count')).toHaveText('Showing 4 of 4')
  })

  test('marks the cut-line band visually distinct (acceptance 3)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    // Three of the four sit in the band in the fixture.
    await expect(page.locator('tr[data-band="true"]')).toHaveCount(3)
  })

  test('renders an unscored dimension as a dash rather than a zero', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    const cell = page.getByTestId(`dim-${seeded.submissionIds[1]}-CHALLENGE_FIDELITY`)
    await expect(cell).toHaveText('—')
  })

  test('sorts by a dimension without lying about the totals', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await page.getByTestId('sort-CHALLENGE_FIDELITY').click()
    // The sort refetches; the counts still describe the field, not the page.
    await expect(page.getByTestId('showing-count')).toHaveText('Showing 4 of 4')
  })

  test('filters in the database and keeps the totals truthful', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await page.getByLabel(/At the cut line/).check()
    await expect(page.getByTestId('showing-count')).toHaveText('Showing 3 of 3')
    await expect(page.getByText(/4 in total/)).toBeVisible()
  })
})

test.describe('finding the review screen at all', () => {
  test('lists scoring runs and links into review', async ({ page }) => {
    await signIn(page)
    await page.getByRole('link', { name: 'Scoring' }).click()

    await expect(page.getByRole('heading', { name: 'Scoring runs' })).toBeVisible()
    await page.getByTestId(`run-${seeded.runIndexId}`)
      .getByRole('link', { name: 'Review' }).click()

    await expect(page.getByRole('heading', { name: /Review · run/ })).toBeVisible()
  })
})

test.describe('one team’s evidence (E08-S02, E08-S03)', () => {
  test('shows the dimensions, the criteria and the repository link', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    await expect(page.getByRole('heading', { name: /Team Scored/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /github\.com/ })).toBeVisible()
    await expect(page.getByTestId('dimension-CHALLENGE_FIDELITY')).toHaveText('88.0')
    await expect(page.getByText(/exponential backoff is present/)).toBeVisible()
  })

  test('states each caveat in plain language, not as a code', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    await expect(page.getByText(/below the 15 needed to compare fidelity/)).toBeVisible()
    await expect(page.getByText('COHORT_BELOW_FLOOR')).toHaveCount(0)
  })

  test('says an unprobed submission was excluded, not scored zero', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)
    await expect(page.getByText(/rather than scored zero/).first()).toBeVisible()
  })

  test('REFUSES to dismiss a caveat without a reason (E08-S03 acceptance 3)', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    await page.getByRole('button', { name: /Dismiss this caveat/ }).click()
    await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeDisabled()
  })

  test('dismisses a caveat with a reason, and keeps it visible afterwards', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    await page.getByRole('button', { name: /Dismiss this caveat/ }).click()
    await page.getByLabel(/Why can this be set aside/)
      .fill('Both challenges share the same absolute anchors; accepted by the chair.')
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click()

    await expect(page.getByText(/0 open/)).toBeVisible()
    await page.getByText('1 dismissed').click()
    await expect(page.getByText(/accepted by the chair/)).toBeVisible()
  })
})

test.describe('system readiness (plan §IV.5)', () => {
  test('shows the definition of done with what was actually found', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await page.getByText(/^Readiness:/).click()

    // Each statement carries its finding, not merely a tick.
    await expect(page.getByTestId('check-two_runs')).toContainText('of 2 score runs')
    await expect(page.getByTestId('check-calibration'))
      .toContainText('uncalibrated system must not rank')
  })

  test('keeps "could not check" distinct from "not done"', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)
    await page.getByText(/^Readiness:/).click()

    const statuses = await page.locator('[data-testid^="check-"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-status')))
    // Every statement is reported, whatever the total — the property is that each carries a
    // real status, not that there are exactly N of them.
    expect(statuses.length).toBeGreaterThanOrEqual(7)
    expect(statuses.every((s) => s === 'PASS' || s === 'FAIL' || s === 'UNKNOWN')).toBe(true)
  })
})

test.describe('the evaluation record (E09-S02)', () => {
  test('is reachable from the team page and downloads the real document', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    const link = page.getByTestId('appeal-packet-link')
    await expect(link).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      link.click(),
    ])
    expect(download.suggestedFilename()).toMatch(/evaluation-record/)

    const stream = await download.createReadStream()
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })

    expect(text).toContain('# Evaluation record')
    expect(text).toContain('Team Scored')
    // The sentence the whole document exists to make defensible.
    expect(text).toMatch(/does not select or eliminate anyone/)
  })

  test('says generating one is recorded', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)
    await expect(page.getByText(/itself recorded in the audit log/)).toBeVisible()
  })
})

test.describe('deciding and finalising (E08-S04, E08-S05)', () => {
  test('REFUSES a decision without a reason', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)
    await expect(page.getByRole('button', { name: /Record decision/ })).toBeDisabled()
  })

  test('records a decision, which then travels with the team', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[1]}`)

    await page.getByLabel(/Exclude/).check()
    await page.getByLabel('Reason').fill('The repository contains another team’s work.')
    await page.getByRole('button', { name: /Record decision/ }).click()

    await expect(page.getByTestId('existing-decision')).toContainText('EXCLUDE')

    // And it appears on the ranked field too (E08-S04 acceptance 3).
    await page.goto(`/review/runs/${seeded.runIndexId}`)
    await expect(page.getByTestId(`row-${seeded.submissionIds[1]}`)).toContainText('EXCLUDE')
  })

  test('BLOCKS finalising while the cut band is undecided, naming the ranks', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await expect(page.getByRole('button', { name: /Finalise shortlist/ })).toBeDisabled()
    await expect(page.getByTestId('finalise-blocked'))
      .toContainText('your judgement changes the outcome')
  })

  test('still BLOCKS when decided but a caveat is unanswered', async ({ page }) => {
    await signIn(page)

    for (const submissionId of seeded.submissionIds.slice(1)) {
      await page.goto(`/review/runs/${seeded.runIndexId}/teams/${submissionId}`)
      await page.getByLabel('Reason').fill('Reviewed the evidence and accept this placement.')
      await page.getByRole('button', { name: /Record decision/ }).click()
      await expect(page.getByTestId('existing-decision')).toBeVisible()
    }

    // Decided, but every one of them still carries the cohort caveat.
    await page.goto(`/review/runs/${seeded.runIndexId}`)
    await expect(page.getByRole('button', { name: /Finalise shortlist/ })).toBeDisabled()
  })

  test('finalises once every band submission is decided AND its caveats answered', async ({ page }) => {
    await signIn(page)

    // The fixture puts ranks 2, 3 and 4 in the band. Each needs both a decision and an answer
    // to the caveat raised about it — the plan's definition of done requires every flag in the
    // cut band to have been reviewed by a person and the review recorded.
    for (const submissionId of seeded.submissionIds.slice(1)) {
      await page.goto(`/review/runs/${seeded.runIndexId}/teams/${submissionId}`)

      await page.getByLabel('Reason').fill('Reviewed the evidence and accept this placement.')
      await page.getByRole('button', { name: /Record decision/ }).click()
      await expect(page.getByTestId('existing-decision')).toBeVisible()

      await page.getByRole('button', { name: /Dismiss this caveat/ }).click()
      await page.getByLabel(/Why can this be set aside/)
        .fill('Both challenges share the same absolute anchors; accepted by the chair.')
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect(page.getByText(/0 open/)).toBeVisible()
    }

    await page.goto(`/review/runs/${seeded.runIndexId}`)
    await page.getByRole('button', { name: /Finalise shortlist/ }).click()

    await expect(page.getByText(/Locked by/)).toBeVisible()

    // And the decisions are now immutable (E08-S04 acceptance 2).
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[1]}`)
    await expect(page.getByRole('status')).toContainText('cannot be changed')
  })
})

test.describe('where the team worked (E27-S03 acceptance 4)', () => {
  test('names the room and coach on the team review page', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[0]}`)

    // A reviewer answering an appeal is reconstructing the day, and a coach named here is the
    // one conflict this page can show: a coach helped produce the work being judged.
    await expect(page.getByText(/Worked in Ada Room · coached by Margaret Hamilton/))
      .toBeVisible()
  })

  test('says nothing at all about a team the roster never placed', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}/teams/${seeded.submissionIds[1]}`)

    // Absent, not "unknown room": this page does not invent a fact to fill a field.
    await expect(page.getByText(/Worked in/)).toHaveCount(0)
  })
})
