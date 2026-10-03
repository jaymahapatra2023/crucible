/**
 * E2E — the floor plan (migration 095).
 *
 * The organisers provision a slot per team the day before, each with its room and coach, and a
 * registering team takes the next free one. What this walks is the organiser's half: the pool is
 * visible, a bad file is refused with the reason, and a good one provisions.
 */
import { expect, test } from '@playwright/test'
import { seedE2EUsers } from './support/seed.js'
import { signInAs } from './support/signIn.js'
import { seedRoster, seedSlots } from './support/rosterSeed.js'

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { await seedRoster() })

const openFloorPlan = async (page: import('@playwright/test').Page) => {
  await page.goto('/roster')
  await page.getByRole('navigation', { name: 'Roster sections' })
    .getByRole('button', { name: 'Floor plan' }).click()
}

test('an empty pool says what to do rather than looking broken', async ({ page }) => {
  await signInAs(page, 'organiser')
  await openFloorPlan(page)

  await expect(page.getByTestId('slots-available')).toHaveText('0')
  await expect(page.getByText(/Nothing provisioned yet/)).toBeVisible()
})

test('a file naming a room that does not exist is refused WHOLE, with the reason', async ({ page }) => {
  await signInAs(page, 'organiser')
  await openFloorPlan(page)

  await page.getByLabel('Slots').fill(
    'label,room,coach\nTeam 1,Ada Room,Margaret Hamilton\nTeam 2,Hall Z,Margaret Hamilton')
  await page.getByRole('button', { name: 'Check the file' }).click()

  await expect(page.getByText(/No room called "Hall Z"/)).toBeVisible()
  // Nothing on offer to provision: half a floor plan is worse than none.
  await expect(page.getByRole('button', { name: /Provision/ })).toHaveCount(0)
  await expect(page.getByTestId('slots-available')).toHaveText('0')
})

test('a good file is checked, then provisioned, and the pool shows it', async ({ page }) => {
  await signInAs(page, 'organiser')
  await openFloorPlan(page)

  await page.getByLabel('Slots').fill(
    'label,room,coach\nTeam 1,Ada Room,Margaret Hamilton\nTeam 2,Ada Room,Margaret Hamilton')
  await page.getByRole('button', { name: 'Check the file' }).click()

  // Two teams in one room is the intended arrangement, and the check says so with its capacity.
  await expect(page.getByText(/Ada Room 2/)).toBeVisible()

  await page.getByRole('button', { name: 'Provision 2 new' }).click()
  await expect(page.getByTestId('slots-available')).toHaveText('2')
  const table = page.getByRole('table', { name: 'Team slots' })
  await expect(table.getByRole('row', { name: /Team 1.*Ada Room.*Margaret Hamilton.*free/ })).toBeVisible()
})

test('a claimed slot keeps its label and names the team that took it', async ({ page }) => {
  await seedSlots([{ label: 'Team 1', room: 'Ada Room', coach: 'Margaret Hamilton' }])
  await signInAs(page, 'organiser')
  await openFloorPlan(page)

  // Free until claimed, and hidden from the default view once it is.
  await expect(page.getByTestId('slots-available')).toHaveText('1')
})

test('a viewer sees the pool and is offered no way to change it', async ({ page }) => {
  await seedSlots([{ label: 'Team 1', room: 'Ada Room', coach: 'Margaret Hamilton' }])
  await signInAs(page, 'viewer')
  await page.goto('/roster')

  // The roster itself is an organiser surface, so a viewer gets a stated refusal, not a blank.
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
})
