/**
 * E2E — a team as something the system knows (E17).
 *
 * Three journeys taken by people who have no account: entering work, reading the standard they
 * will be judged by, and checking afterwards that the entry is still good. Plus the organiser
 * side of the same fact — that issuing a token issues an identity, and that a name already in
 * use is said out loud before a second team is created under it.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedIntake, type SeededIntake } from './support/intakeSeed.js'

let intake: SeededIntake

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { intake = await seedIntake() })

const form = (page: Page) => page.locator('form')

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.describe('reading the standard from the form (E17-S04)', () => {
  test('offers no rubric link until a challenge is chosen — the rubric is per challenge', async ({ page }) => {
    await page.goto('/submit')
    await expect(page.getByRole('link', { name: /Read the rubric/ })).toHaveCount(0)
  })

  test('links the published rubric once a challenge is chosen', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('Challenge').selectOption(String(intake.challengeId))

    const link = page.getByRole('link', { name: /Read the rubric/ })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /\/api\/v1\/rubrics\/published\//)
  })

  test('the link actually serves the rubric, with no account', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('Challenge').selectOption(String(intake.challengeId))

    const href = await page.getByRole('link', { name: /Read the rubric/ }).getAttribute('href')
    const served = await page.request.get(href!)
    expect(served.status()).toBe(200)
  })

  test('says the entry will be judged against exactly what was published', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('Challenge').selectOption(String(intake.challengeId))
    await expect(page.getByText(/exactly as it was published/)).toBeVisible()
  })
})

test.describe('a team checking their own entry (E17-S03)', () => {
  test('cannot be looked up without a token', async ({ page }) => {
    await page.goto('/submit')
    await expect(page.getByRole('button', { name: 'Check my entry' })).toBeDisabled()
    await expect(page.getByText(/Enter your submission token first/)).toBeVisible()
  })

  test('says plainly that nothing has been entered yet', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('Submission token').fill(intake.token)
    await page.getByRole('button', { name: 'Check my entry' }).click()

    await expect(page.getByText(/no entry recorded yet/i)).toBeVisible()
  })

  test('REFUSES a token that is not theirs, rather than showing an empty entry', async ({ page }) => {
    // Showing nothing would read as "you never submitted" — a different and much worse thing
    // to believe on the evening of a deadline.
    await page.goto('/submit')
    await form(page).getByLabel('Submission token').fill('crs_not-a-real-token')
    await page.getByRole('button', { name: 'Check my entry' }).click()

    await expect(page.getByRole('alert')).toContainText(/not valid|not a valid submission token/i)
  })

  test('shows the entry a team made, with the commit that will be evaluated', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('Submission token').fill(intake.token)
    await form(page).getByLabel('Contact email').fill('night@team.test')
    await form(page).getByLabel('Challenge').selectOption(String(intake.challengeId))
    await form(page).getByLabel('Repository URL').fill('https://github.com/example/does-not-exist')
    await page.getByRole('button', { name: 'Submit entry' }).click()
    await expect(page.getByRole('heading', { name: 'Entry received' }))
      .toBeVisible({ timeout: 25_000 })

    // Back to the form, and now the lookup finds it — without signing in anywhere.
    await page.goto('/submit')
    await form(page).getByLabel('Submission token').fill(intake.token)
    await page.getByRole('button', { name: 'Check my entry' }).click()

    await expect(page.getByText('E2E team').first()).toBeVisible()
    await expect(page.getByText(intake.challengeName).first()).toBeVisible()
  })
})

test.describe('issuing a token issues a team (E17-S01)', () => {
  test('asks for a contact as well as a name — there is no account to fall back on', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel('Team name').fill('Daylight Robbery')
    await expect(page.getByRole('button', { name: /Create team and issue token/ })).toBeDisabled()

    await page.getByLabel('Contact email').fill('day@team.test')
    await expect(page.getByRole('button', { name: /Create team and issue token/ })).toBeEnabled()
  })

  test('creates the team and shows the token once', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel('Team name').fill('Daylight Robbery')
    await page.getByLabel('Contact email').fill('day@team.test')
    await page.getByRole('button', { name: /Create team and issue token/ }).click()

    await expect(page.getByText('Token for Daylight Robbery')).toBeVisible()
    await expect(page.getByText(/cannot be shown again/)).toBeVisible()
  })

  test('WARNS that a name is already taken in all but punctuation (G13)', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel('Team name').fill('Daylight Robbery')
    await page.getByLabel('Contact email').fill('day@team.test')
    await page.getByRole('button', { name: /Create team and issue token/ }).click()
    await expect(page.getByText('Token for Daylight Robbery')).toBeVisible()
    await page.getByRole('button', { name: /I have copied it/ }).click()

    await page.getByLabel('Team name').fill('The Daylight-Robbery')
    await expect(page.getByText(/already registered under/i)).toBeVisible()
    await expect(page.getByText(/the two will rank separately/i)).toBeVisible()
  })

  test('reissues against an EXISTING team instead of making a second one', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    // The team seeded with the fixture is already there to reissue for — selected by id,
    // which is the whole point: the name is not what identifies them.
    await page.getByLabel('Team', { exact: true }).selectOption(String(intake.teamId))
    await expect(page.getByLabel('Team name')).toHaveCount(0)
    // Since E47-S01 a replacement stops the old code, so it asks why before it will issue.
    await page.getByLabel(/Why the code is being replaced/).fill('team lost it')
    await page.getByRole('button', { name: /Replace this team's code/ }).click()

    await expect(page.getByText('Token for E2E team')).toBeVisible()
    await expect(page.getByText(/previous code has stopped working/)).toBeVisible()
  })
})

test.describe('the team is resolved, not typed (E45-S01)', () => {
  test('the submit form has no team-name field and shows what the token resolves to', async ({ page }) => {
    await page.goto('/submit')
    // Renaming a team by typing at submission is gone: it silently renamed a real team during
    // testing, and identity is the token.
    await expect(form(page).getByLabel('Team name')).toHaveCount(0)

    await form(page).getByLabel('Submission token').fill(intake.token)
    await expect(form(page).getByTestId('resolved-team')).toContainText('Submitting as')
    await expect(form(page).getByTestId('resolved-team')).toContainText('E2E team')
  })

  test('a token bound to no team is refused at the form, with the reason', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('Submission token').fill('crs_definitely-not-issued-0000')
    await expect(form(page).getByRole('alert')).toContainText(/not valid/i)
  })
})
