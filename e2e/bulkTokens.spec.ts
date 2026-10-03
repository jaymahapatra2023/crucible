/**
 * E2E — registering a cohort from one file (E20).
 *
 * The journey an organiser takes once, under time pressure, for every team at the event. Its
 * failure mode is specific: tokens exist, nobody holds them, and fifty teams cannot enter.
 *
 * So the two things walked here are that checking writes nothing, and that a token issued in
 * bulk actually lets a team in — proved by using one on the submission page rather than by
 * asserting it looks like a token.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedIntake } from './support/intakeSeed.js'

test.beforeAll(async () => { await seedE2EUsers() })
// The seeded cohort is a precondition, not a handle: these journeys reach the team it registers
// through the page, by the name it was registered under.
test.beforeEach(async () => { await seedIntake() })

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

const FILE = [
  'team_name,contact_email',
  'The Night Shift,night@team.test',
  'Daylight Robbery,day@team.test',
].join('\n')

async function paste(page: Page, text: string) {
  await page.getByLabel('Teams').fill(text)
}

test.describe('checking before registering', () => {
  test('says what would happen, and creates nothing', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await paste(page, FILE)
    await page.getByRole('button', { name: 'Check the file' }).click()

    const table = page.getByRole('table', { name: /teams in this file/i })
    await expect(table).toBeVisible()
    await expect(table.getByText('The Night Shift')).toBeVisible()
    await expect(table.getByText('Daylight Robbery')).toBeVisible()
    await expect(page.getByRole('button', { name: /Register 2 teams/ })).toBeEnabled()

    // Nothing was written: the teams dropdown beside it still offers only the seeded team.
    await expect(page.getByLabel('Team', { exact: true })).not.toContainText('Daylight Robbery')
  })

  test('REFUSES a file it cannot read, naming what is wrong', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await paste(page, 'Night Shift,night@team.test')
    await page.getByRole('button', { name: 'Check the file' }).click()

    await expect(page.getByRole('alert')).toContainText(/header row is missing/i)
  })

  test('will not register while a row cannot be acted on', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await paste(page, 'team_name,contact_email\nGood Team,good@team.test\nBad Row,nope')
    await page.getByRole('button', { name: 'Check the file' }).click()

    // Scoped to the table: the summary line above it names the same states.
    const table = page.getByRole('table', { name: /teams in this file/i })
    await expect(table.getByText('cannot be read', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Register 2 teams/ })).toBeDisabled()
    await expect(page.getByText(/Fix the 1 row below first/)).toBeVisible()
  })

  test('recognises a team that already exists rather than creating a second', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    // The fixture already registered "E2E team"; the same name in all but punctuation must match.
    await paste(page, 'team_name,contact_email\nThe E2E-Team,e2e@team.test')
    await page.getByRole('button', { name: 'Check the file' }).click()

    const table = page.getByRole('table', { name: /teams in this file/i })
    await expect(table.getByText('already registered', { exact: true })).toBeVisible()
    await expect(page.getByText(/REPLACEMENT token/)).toBeVisible()
  })
})

test.describe('registering', () => {
  test('issues every token and insists they are saved now', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await paste(page, FILE)
    await page.getByRole('button', { name: 'Check the file' }).click()
    await page.getByRole('button', { name: /Register 2 teams/ }).click()

    await expect(page.getByText(/2 tokens issued\. Save them now\./)).toBeVisible()
    await expect(page.getByText(/only time they can be read/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /Register 2 teams/ })).toHaveCount(0)
  })

  test('downloads the tokens as a file', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await paste(page, FILE)
    await page.getByRole('button', { name: 'Check the file' }).click()
    await page.getByRole('button', { name: /Register 2 teams/ }).click()

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Download the tokens/ }).click(),
    ]).then(([d]) => d)

    expect(download.suggestedFilename()).toBe('crucible-team-tokens.csv')
  })

  test('the teams appear in the panel beside it, once the tokens are saved', async ({ page }) => {
    // Refreshing the page's data blanks it while it reloads, which would unmount the panel
    // holding the only copy of the tokens. So it happens after they are in a file, not before.
    await signIn(page)
    await page.goto('/intake')

    await paste(page, FILE)
    await page.getByRole('button', { name: 'Check the file' }).click()
    await page.getByRole('button', { name: /Register 2 teams/ }).click()
    await expect(page.getByText(/2 tokens issued/)).toBeVisible()

    await expect(page.getByLabel('Team', { exact: true })).not.toContainText('Daylight Robbery')

    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Download the tokens/ }).click(),
    ])
    await expect(page.getByLabel('Team', { exact: true })).toContainText('Daylight Robbery')
  })

  test('a token issued in bulk actually lets a team submit', async ({ page }) => {
    // The assertion that matters. A file of plausible-looking tokens that do not work is the
    // failure this whole path exists to avoid, and it is only visible from the team's side.
    await signIn(page)
    await page.goto('/intake')

    await paste(page, FILE)
    await page.getByRole('button', { name: 'Check the file' }).click()
    await page.getByRole('button', { name: /Register 2 teams/ }).click()
    await expect(page.getByText(/2 tokens issued/)).toBeVisible()

    // The plaintext comes from the downloaded file, which is where an organiser would actually
    // get it — the table on screen deliberately never shows it.
    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Download the tokens/ }).click(),
    ]).then(([d]) => d)

    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const csv = Buffer.concat(chunks).toString('utf8')

    // Every cell is quoted — the shared writer's format — so the token is pulled out by shape
    // rather than by splitting on commas.
    const row = csv.split('\n').find((l) => l.startsWith('"The Night Shift"'))!
    const plaintext = /"(crs_[^"]+)"/.exec(row)![1]!
    expect(plaintext).toMatch(/^crs_/)

    await page.goto('/submit')
    await page.getByLabel('Submission token').fill(plaintext)
    await page.getByRole('button', { name: 'Check my entry' }).click()

    await expect(page.getByText('The Night Shift').first()).toBeVisible()
    await expect(page.getByText(/no entry recorded yet/i)).toBeVisible()
  })
})
