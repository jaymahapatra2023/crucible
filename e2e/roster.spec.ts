/**
 * E2E — an organiser putting people on teams (E27, E28).
 *
 * The journey that has to work at 200 people on the morning of an event, done here with four.
 * What is walked is the fast path: type, press Enter, next. Plus the two things that make that
 * safe — the count that says whether it is finished, and undo.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedRoster } from './support/rosterSeed.js'

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { await seedRoster() })

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

const search = (page: Page) => page.getByLabel('Find a participant')

test.describe('assigning people to teams', () => {
  test('is reachable from the primary navigation', async ({ page }) => {
    await signIn(page)
    await page.getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Roster' }).click()
    await expect(page.getByRole('heading', { name: 'Roster', level: 1 })).toBeVisible()
  })

  test('shows how many are still to assign, as the first thing on the page', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await expect(page.getByTestId('unassigned-count')).toHaveText('4')
    await expect(page.getByText(/of 4 still to assign/)).toBeVisible()
  })

  test('assigns on Enter and counts down, without touching a button', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await search(page).fill('ada')
    await search(page).press('Enter')

    await expect(page.getByTestId('unassigned-count')).toHaveText('3')
    // The box clears and keeps focus, so the next name goes straight in.
    await expect(search(page)).toHaveValue('')
    await expect(search(page)).toBeFocused()
  })

  test('puts them on the team that was selected, and keeps it selected', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await page.getByRole('button', { name: /Daylight Robbery/ }).click()
    await search(page).fill('grace')
    await search(page).press('Enter')
    await search(page).fill('alan')
    await search(page).press('Enter')

    await expect(page.getByTestId('unassigned-count')).toHaveText('2')
    const teams = page.getByRole('list', { name: 'Teams' })
    await expect(teams.getByText('Grace Hopper')).toBeVisible()
    await expect(teams.getByText('Alan Turing')).toBeVisible()
  })

  test('makes the first member the point of contact', async ({ page }) => {
    // A team whose contact is nobody cannot be sent its token.
    await signIn(page)
    await page.goto('/roster')

    await search(page).fill('ada')
    await search(page).press('Enter')

    await expect(page.getByText(/point of contact/)).toBeVisible()
  })

  test('UNDOES the last assignment, naming what it would undo', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await search(page).fill('ada')
    await search(page).press('Enter')
    await expect(page.getByTestId('unassigned-count')).toHaveText('3')

    await page.getByRole('button', { name: /Undo — Ada Lovelace/ }).click()
    await expect(page.getByTestId('unassigned-count')).toHaveText('4')
  })

  test('takes somebody off a team without removing them from the roster', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await search(page).fill('ada')
    await search(page).press('Enter')
    await page.getByRole('button', { name: 'Remove' }).click()

    // Back to unassigned, still a participant.
    await expect(page.getByTestId('unassigned-count')).toHaveText('4')
    await expect(page.getByText(/of 4 still to assign/)).toBeVisible()
  })

  test('says everybody is on a team once nobody is left', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    for (const name of ['ada', 'grace', 'alan', 'katherine']) {
      await search(page).fill(name)
      await search(page).press('Enter')
    }

    await expect(page.getByTestId('unassigned-count')).toHaveText('0')
    await expect(page.getByText(/Everybody is on a team/)).toBeVisible()
  })
})

test.describe('what is not ready', () => {
  test('names the people not on a team, rather than counting them', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await expect(page.getByText(/not on a team/)).toBeVisible()
    await expect(page.getByText(/Ada Lovelace/).first()).toBeVisible()
  })

  test('names teams with no room and no coach', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await expect(page.getByText(/no room: /)).toBeVisible()
    await expect(page.getByText(/no coach: /)).toBeVisible()
  })
})

test.describe('loading a list from a file', () => {
  test('checks without writing, then loads', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await page.getByLabel('Rows').fill(
      'full_name,email,team_name\nAlan Kay,kay@example.test,Night Shift')
    await page.getByRole('button', { name: 'Check the file' }).click()

    const rows = page.getByRole('table', { name: /rows in this file/i })
    await expect(rows.getByText('Alan Kay')).toBeVisible()
    await expect(rows.getByText('Night Shift')).toBeVisible()
    // Nothing written yet.
    await expect(page.getByTestId('unassigned-count')).toHaveText('4')

    await page.getByRole('button', { name: /Load 1 new/ }).click()
    // Imported AND assigned from the team column, so the unassigned count does not move.
    await expect(page.getByText(/of 5 still to assign/)).toBeVisible()
  })

  test('REFUSES a file with an unusable row, naming it', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await page.getByLabel('Rows').fill(
      'full_name,email\nGood Person,good@example.test\nBad,nope')
    await page.getByRole('button', { name: 'Check the file' }).click()

    // Scoped to the table: the summary line above it names the same states.
    const rows = page.getByRole('table', { name: /rows in this file/i })
    await expect(rows.getByText('cannot be read', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Load 1 new/ })).toBeDisabled()
    await expect(page.getByText(/Fix the 1 row below first/)).toBeVisible()
  })
})

test.describe('creating a team from the assignment surface', () => {
  test('creates it with the person who needed it, and assigns them in one act', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    // The reason this control exists: somebody is found who belongs on a team that is not there.
    await search(page).fill('ada')
    await expect(page.getByText('Ada Lovelace', { exact: true })).toBeVisible()

    await page.getByLabel('Create a team').fill('Moonlighters')
    await page.getByRole('button', { name: 'Create' }).click()

    // She is on it, it is selected, and the count moved — one act, not three.
    await expect(page.getByTestId('unassigned-count')).toHaveText('3')
    const teams = page.getByRole('list', { name: 'Teams' })
    await expect(teams.getByRole('button', { name: /Moonlighters/ })).toHaveAttribute(
      'aria-pressed', 'true')
    await expect(teams.getByText(/point of contact/)).toBeVisible()

    // And the next Enter goes to the new team, not to whichever was selected before.
    await search(page).fill('grace')
    await search(page).press('Enter')
    await expect(page.getByTestId('unassigned-count')).toHaveText('2')
    await expect(teams.getByText('Grace Hopper')).toBeVisible()
  })

  test('refuses a name that is an existing team after normalisation, naming it', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    // 'Night Shift' is already seeded; this normalises to the same team.
    await page.getByLabel('Create a team').fill('the night-shift!')
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page.getByRole('alert')).toContainText(/Night Shift already exists/)
  })
})

test.describe('running the roster from the app', () => {
  const tab = (page: Page, name: string) =>
    page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name })

  test('adds a participant by hand, who then appears to be assigned', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await tab(page, 'People').click()
    await page.getByLabel('Full name').fill('Alan Kay')
    await page.getByLabel('Email').fill('kay@example.test')
    await page.getByRole('button', { name: 'Add participant' }).click()

    await expect(page.getByRole('row', { name: /Alan Kay/ })).toBeVisible()
    // E40 replaced the "N shown of M" line with the pager, which says the same thing in rows.
    await expect(page.getByTestId('pager')).toContainText('of 5')

    // The point of adding them: they are now assignable on the board.
    await tab(page, 'Assign').click()
    await expect(page.getByTestId('unassigned-count')).toHaveText('5')
    await search(page).fill('kay')
    await search(page).press('Enter')
    await expect(page.getByTestId('unassigned-count')).toHaveText('4')
  })

  test('refuses a second participant with the same address, naming who has it', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await tab(page, 'People').click()

    await page.getByLabel('Full name').fill('Someone Else')
    await page.getByLabel('Email').fill('ada@example.test')
    await page.getByRole('button', { name: 'Add participant' }).click()

    await expect(page.getByRole('alert')).toContainText(/already on the roster/)
  })

  test('corrects a participant in place', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await tab(page, 'People').click()

    const row = page.getByRole('row', { name: /Ada Lovelace/ })
    await row.getByRole('button', { name: 'Edit' }).click()
    // Scoped to the edit form: the add form above has a field with the same label.
    const form = page.getByRole('form', { name: 'Edit Ada Lovelace' })
    await form.getByLabel('Full name').fill('Ada Byron')
    await form.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('row', { name: /Ada Byron/ })).toBeVisible()
  })

  test('adds a coach, then gives a team that coach and a room', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')

    await tab(page, 'Rooms & coaches').click()
    await page.getByLabel('Coach name').fill('Katherine Johnson')
    await page.getByLabel('Coach email').fill('kj@example.test')
    await page.getByRole('button', { name: 'Add coach' }).click()
    await expect(page.getByRole('list', { name: 'Coaches' })
      .getByText('Katherine Johnson')).toBeVisible()

    await tab(page, 'Logistics').click()
    await page.getByLabel('Coach for Night Shift').selectOption({ label: 'Katherine Johnson' })
    await page.getByLabel('Room for Night Shift').selectOption({ label: 'Ada Room — First floor' })

    await expect(page.getByText(/1 of 2 without a room, 1 without a coach/)).toBeVisible()

    // And it shows where a team sits wherever the team is named to an organiser.
    await tab(page, 'Assign').click()
    await expect(page.getByRole('list', { name: 'Teams' })
      .getByRole('button', { name: /Night Shift.*Ada Room.*Katherine Johnson/ })).toBeVisible()
  })

  test('says a room is taken rather than hiding it from the other team', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await tab(page, 'Logistics').click()

    await page.getByLabel('Room for Night Shift').selectOption({ label: 'Ada Room — First floor' })
    await expect(page.getByLabel('Room for Daylight Robbery'))
      .toContainText(/Ada Room.*\(with Night Shift\)/)
  })

  test('adds a room and takes another out of use without deleting it', async ({ page }) => {
    await signIn(page)
    await page.goto('/roster')
    await tab(page, 'Rooms & coaches').click()

    await page.getByLabel('Room label').fill('Babbage')
    await page.getByLabel('Room location').fill('Second floor')
    await page.getByRole('button', { name: 'Add room' }).click()
    await expect(page.getByRole('list', { name: 'Rooms' }).getByText('Babbage')).toBeVisible()

    // `click`, not `uncheck`: the box is controlled by the server's answer, so it does not flip
    // on the click itself and uncheck's synchronous assertion would race the round trip.
    await page.getByRole('checkbox', { name: 'Ada Room in use' }).click()
    await expect(page.getByRole('checkbox', { name: 'Ada Room in use' })).not.toBeChecked()
    // Still listed. A room used yesterday still has to exist.
    await expect(page.getByRole('list', { name: 'Rooms' }).getByText('Ada Room')).toBeVisible()
    await expect(page.getByText('Out of use')).toBeVisible()
  })
})
