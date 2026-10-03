/**
 * E2E — a team entering their work (E03-S01).
 *
 * The one journey in Crucible taken by someone who is not staff, under time pressure, probably
 * minutes before a deadline. Its failures are unrecoverable in a way the rest of the system's
 * are not: a team that cannot submit has no second chance, and a team that submits a build
 * configuration that cannot work finds out only after judging.
 *
 * So the page has to say three things clearly: whether intake is open, what is wrong with the
 * entry before it is sent, and which commit was locked afterwards.
 */
import { expect, test, type Page } from '@playwright/test'
import { closeIntake, seedIntake, type SeededIntake } from './support/intakeSeed.js'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'

let intake: SeededIntake

// Staff accounts are needed only by the navigation journey at the end, but seeding them once
// here is cheaper than a second beforeAll that has to order itself against this one.
test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { intake = await seedIntake() })

const form = (page: Page) => page.locator('form')

async function fillEntry(page: Page) {
  const f = form(page)
  await f.getByLabel('Submission token').fill(intake.token)
  // E45-S01: the token names the team; the form shows it rather than asking for it.
  await expect(f.getByTestId('resolved-team')).toContainText('E2E team')
  await f.getByLabel('Contact email').fill('team@example.com')
  await f.getByLabel('Challenge').selectOption(String(intake.challengeId))
  await f.getByLabel('Repository URL').fill('https://github.com/example/does-not-exist')
}

test.describe('the submission form', () => {
  test('is reachable without signing in — teams have no account by design', async ({ page }) => {
    await page.goto('/submit')
    await expect(page.getByRole('heading', { name: 'Submit your entry' })).toBeVisible()
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('says whether intake is open before anything is filled in', async ({ page }) => {
    await page.goto('/submit')
    await expect(page.getByRole('status')).toContainText('OPEN')
  })

  test('offers the open challenges by name', async ({ page }) => {
    await page.goto('/submit')
    await expect(form(page).getByLabel('Challenge')).toContainText(intake.challengeName)
  })

  test('says what is wrong before sending, naming each field', async ({ page }) => {
    await page.goto('/submit')
    await page.getByRole('button', { name: 'Submit entry' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('submission token')
    await expect(alert).toContainText('contact email')
    await expect(alert).toContainText('Choose the challenge')
  })

  test('asks for a build command instead of a Dockerfile when the method changes', async ({ page }) => {
    await page.goto('/submit')
    await form(page).getByLabel('How your project builds').selectOption('COMMAND')

    await expect(form(page).getByLabel('Build and start command')).toBeVisible()
    await expect(form(page).getByLabel('Dockerfile path')).toHaveCount(0)
  })

  test('warns that getting the build method wrong costs a working probe', async ({ page }) => {
    await page.goto('/submit')
    await expect(page.getByText(/difference between 'runs' and 'could not be built'/))
      .toBeVisible()
  })
})

test.describe('submitting', () => {
  test('records the entry and reports what was validated', async ({ page }) => {
    await page.goto('/submit')
    await fillEntry(page)
    await page.getByRole('button', { name: 'Submit entry' }).click()

    // Longer than the default: submitting performs a real repository reachability check, so
    // this assertion waits on a network round-trip that has nothing to do with the UI. Seven
    // seconds was enough when this spec ran alone and not when the suite ran together, which
    // is the shape of a flake rather than a product defect.
    await expect(page.getByRole('heading', { name: 'Entry received' }))
      .toBeVisible({ timeout: 25_000 })
    await expect(page.getByText('E2E team')).toBeVisible()
    // The repository does not exist, so the honest outcome is a stated validation failure —
    // not a silent success, and not a lost entry.
    await expect(page.getByText(/Validation:/)).toBeVisible()
    // E38: three states, and this fixture is the failed one. It must NOT read as the ordinary
    // "not locked yet" reassurance, which is what the old single warning conflated it with.
    await expect(page.getByText(/could not be read/)).toBeVisible()
    await expect(page.getByText(/taken when intake closes/)).toHaveCount(0)
  })

  test('refuses a token that is not valid, and says so plainly', async ({ page }) => {
    await page.goto('/submit')
    await fillEntry(page)
    await form(page).getByLabel('Submission token').fill('crs_not-a-real-token')
    await page.getByRole('button', { name: 'Submit entry' }).click()

    await expect(page.getByRole('alert'))
      .toContainText(/not valid|has been revoked|not a valid submission token/i)
    // And the team is not bounced to a sign-in page they have no account for.
    await expect(page).toHaveURL(/\/submit$/)
  })
})

test.describe('when intake is closed', () => {
  test('says so and disables submission rather than failing on send', async ({ page }) => {
    await closeIntake()
    await page.goto('/submit')

    await expect(page.getByRole('status')).toContainText('CLOSED')
    await expect(page.getByRole('button', { name: 'Submit entry' })).toBeDisabled()
    await expect(page.getByText(/Contact your organiser if you believe this is wrong/))
      .toBeVisible()
  })
})

test.describe('reaching the entry form from the app', () => {
  test('is in the primary navigation, so staff can see what teams see', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(E2E_USERS.admin.email)
    await page.getByLabel('Password').fill(E2E_USERS.admin.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/runs$/)

    await page.getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Submit' }).click()

    await expect(page).toHaveURL(/\/submit$/)
    // The team-facing form, token and all — not the organiser's on-behalf path.
    await expect(page.getByLabel('Submission token')).toBeVisible()
  })
})
