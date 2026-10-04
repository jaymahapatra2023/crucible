/**
 * E2E — the event, end to end, through the screens (E50).
 *
 * One connected journey across the four modules: an organiser prepares rooms and coaches, a
 * participant registers a team from the roster, the organiser places the team and reads its
 * code back, the team submits, the organiser sees the entry and runs its checks, intake locks,
 * and a scoring run is started. Every step reads what the previous one wrote — which is the
 * only way to find a seam where two modules disagree about a team, a token or a window.
 *
 * Seeded at the boundaries only: the rubric (its generation needs a model) and the registration
 * link (no mail is transmitted in test). Everything else is done as a person would do it.
 */
import { expect, test, type Page } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { signInAs } from './support/signIn.js'
import { LIFECYCLE_CHALLENGE, LIFECYCLE_LINK, seedLifecycle } from './support/lifecycleSeed.js'

const TEAM = 'Night Shift'
// A real, public repository with a manifest, so validation and the scan can run; the probe
// needs Docker and reports honestly when it cannot.
const REPO = 'https://github.com/gothinkster/node-express-realworld-example-app'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { await seedE2EUsers(); await seedLifecycle() })

let token = ''

const tokenRow = (page: Page) =>
  page.getByRole('table', { name: 'Submission tokens' }).getByRole('row', { name: new RegExp(TEAM) })

test('1 · the organiser prepares a room and a coach', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto('/roster')
  await page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name: 'Rooms & coaches' }).click()
  await page.getByLabel('Room label').fill('Ada Room')
  await page.getByLabel('Room location').fill('First floor')
  await page.getByRole('button', { name: 'Add room' }).click()
  await page.getByLabel('Coach name').fill('Margaret Hamilton')
  await page.getByLabel('Coach email').fill('margaret@example.test')
  await page.getByRole('button', { name: 'Add coach' }).click()
  await expect(page.getByRole('list', { name: 'Coaches' })).toContainText('Margaret Hamilton')
})

test('2 · a participant registers the team from the link, and never sees a code', async ({ page }) => {
  await page.goto(`/register?link=${LIFECYCLE_LINK}`)
  await expect(page.getByText(/Registering as/)).toContainText('Ada Lovelace')
  await page.getByLabel('Team name').fill(TEAM)
  await expect(page.getByRole('status').filter({ hasText: 'Available.' })).toBeVisible()
  const box = page.getByLabel(/Add a teammate by email/)
  for (const [email, name] of [['grace@example.test', 'Grace Hopper'], ['alan@example.test', 'Alan Turing']]) {
    await box.fill(email!)
    await box.press('Enter')
    await expect(page.getByRole('list', { name: 'Team members' })).toContainText(name!)
  }
  await expect(page.getByTestId('member-count')).toHaveText('3')
  await page.getByRole('button', { name: 'Register the team' }).click()
  await expect(page.getByTestId('registered')).toContainText(`${TEAM} is registered`)
  await expect(page.locator('body')).not.toContainText('crs_')
})

test('3 · the roster shows the team, and the organiser places it', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto('/roster')
  const teams = page.getByRole('list', { name: 'Teams' })
  await expect(teams.getByRole('button', { name: new RegExp(TEAM) })).toBeVisible()
  // Three people came off the unassigned list by registering themselves.
  await expect(page.getByTestId('unassigned-count')).toHaveText('1')

  await page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name: 'Logistics' }).click()
  await page.getByLabel(`Coach for ${TEAM}`).selectOption({ label: 'Margaret Hamilton' })
  await page.getByLabel(`Room for ${TEAM}`).selectOption({ label: 'Ada Room — First floor' })
  await page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name: 'Assign' }).click()
  await expect(teams.getByRole('button', { name: new RegExp(`${TEAM}.*Ada Room.*Margaret Hamilton`) })).toBeVisible()
})

test('4 · intake holds the team\'s code; an admin reads it back, audited', async ({ page }) => {
  await signInAs(page, 'admin')
  await page.goto('/intake')
  await expect(tokenRow(page)).toBeVisible()
  await tokenRow(page).getByRole('button', { name: 'Reveal' }).click()
  await expect(page.getByText(/read back under your name/)).toBeVisible()
  token = (await page.locator('code', { hasText: /^crs_/ }).first().textContent())?.trim() ?? ''
  expect(token).toMatch(/^crs_/)
})

test('5 · the team submits with that code, and can check its own entry', async ({ page }) => {
  await page.goto('/submit')
  const form = page.locator('form')
  await form.getByLabel('Submission token').fill(token)
  await expect(form.getByTestId('resolved-team')).toContainText(TEAM)
  await form.getByLabel('Contact email').fill('ada@example.test')
  await form.getByLabel('Challenge').selectOption({ label: LIFECYCLE_CHALLENGE })
  await form.getByLabel('Repository URL').fill(REPO)
  await form.getByLabel('How your project builds').selectOption('COMMAND')
  await form.getByLabel('Build and start command').fill('npm ci && npm start')
  await page.getByRole('button', { name: 'Submit entry' }).click()
  await expect(page.getByRole('heading', { name: 'Entry received' })).toBeVisible({ timeout: 40_000 })
  await expect(page.getByText(/Validation:/)).toBeVisible()

  await page.goto('/submit')
  await page.locator('form').getByLabel('Submission token').fill(token)
  await page.getByRole('button', { name: 'Check my entry' }).click()
  await expect(page.getByText(TEAM).first()).toBeVisible()
  await expect(page.getByText(REPO).first()).toBeVisible()
})

test('6 · the organiser sees the entry, the chase list drops the team, and the automatic checks settle', async ({ page }) => {
  // The poll below allows 120s; without this the test's own 30s cap expires first, so the
  // allowance was never real. It passed only while the checks happened to settle inside 30s —
  // the COMMAND path now prepares a sandbox image before it runs anything, which is slower.
  test.setTimeout(180_000)
  await signInAs(page, 'organiser')
  await page.goto('/intake')
  await expect(page.getByTestId('count-submitted')).toHaveText('1')
  await expect(page.getByTestId('chase-empty')).toBeVisible()

  const entries = page.getByRole('table', { name: 'Every current entry' })
  const row = entries.getByRole('row', { name: new RegExp(TEAM) })
  await expect(row).toBeVisible()
  await expect(row).toContainText('VALID')
  // A valid self-service entry is checked without anybody pressing anything (E46-S01).
  await expect(row).not.toContainText('Not checked')
  await expect.poll(async () => {
    await page.reload()
    return page.getByRole('table', { name: 'Every current entry' }).getByRole('row', { name: new RegExp(TEAM) }).textContent()
  }, { timeout: 120_000, intervals: [2000, 3000, 5000] }).toMatch(/READY|PROBLEMS|Could not be checked|did not finish/)
})

test('7 · intake locks, and the public form says so while a team can still read its entry', async ({ page }) => {
  await signInAs(page, 'organiser')
  await page.goto('/intake')
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: /Lock intake permanently/ }).click()
  await expect(page.getByTestId('intake-state')).toHaveText('LOCKED')

  await page.goto('/submit')
  await expect(page.getByRole('button', { name: 'Submit entry' })).toBeDisabled()
  await page.locator('form').getByLabel('Submission token').fill(token)
  await page.getByRole('button', { name: 'Check my entry' }).click()
  await expect(page.getByText(TEAM).first()).toBeVisible()
})

test('8 · a scoring run starts from the app and is watched on the batch page until it settles', async ({ page }) => {
  test.setTimeout(240_000)
  await signInAs(page, 'organiser')
  await page.goto('/scoring')
  await page.getByLabel(/^Cohort/).fill('lifecycle')
  await page.getByRole('checkbox', { name: LIFECYCLE_CHALLENGE }).check()
  await page.getByRole('button', { name: /Start run 1/ }).click()
  await expect(page).toHaveURL(/\/batch\/runs\/\d+$/)
  await expect(page.getByTestId('run-status')).toBeVisible()

  // Scan clones the real repository; the probe and the scorer report what this host lacks. The
  // journey waits for the run to stop so nothing writes after the next spec re-seeds.
  await expect.poll(async () => {
    await page.reload()
    return page.getByTestId('run-status').textContent()
  }, { timeout: 200_000, intervals: [3000, 5000] }).toMatch(/SUCCEEDED|COMPLETED|FAILED|PAUSED/)
  await expect(page.getByTestId('stage-scan')).toContainText(/1 of 1/)
})
