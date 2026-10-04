/**
 * E2E — the organiser's intake dashboard (E03-S05).
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers, seedIntake } from './support/seed.js'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_USERS.admin.email)
  await page.getByLabel('Password').fill(E2E_USERS.admin.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

test.beforeAll(async () => { await seedE2EUsers() })
test.beforeEach(async () => { await seedIntake() })

test.describe('intake dashboard', () => {
  test('shows real counts by status', async ({ page }) => {
    await signIn(page)
    await page.getByRole('link', { name: 'Intake' }).click()

    await expect(page.getByTestId('count-submitted')).toHaveText('3')
    await expect(page.getByTestId('count-valid')).toHaveText('1')
    await expect(page.getByTestId('count-private')).toHaveText('1')
    await expect(page.getByTestId('count-rejected')).toHaveText('1')
  })

  test('reports whether intake is open', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await expect(page.getByTestId('intake-state')).toHaveText('OPEN')
    await expect(page.getByText(/Submissions are open until/)).toBeVisible()
  })

  test('lists every failing submission with its reason and a contact link', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    // Addressed by what it is, not by position: a positional locator breaks the moment
    // another table is added to the page, which is exactly what happened.
    const needsChasing = page.getByRole('table', { name: 'Submissions needing chasing' })
    await expect(needsChasing.getByText('Team Beta')).toBeVisible()
    await expect(needsChasing.getByText(/would not serve this repository/)).toBeVisible()
    await expect(page.getByRole('link', { name: 'beta@team.test' }))
      .toHaveAttribute('href', 'mailto:beta@team.test')
  })

  test('does not list a valid submission as needing chasing', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    // Addressed by what it is, not by position: a positional locator breaks the moment
    // another table is added to the page, which is exactly what happened.
    const needsChasing = page.getByRole('table', { name: 'Submissions needing chasing' })
    await expect(needsChasing.getByText('Team Alpha')).toHaveCount(0)
  })

  test('exports a CSV that actually downloads', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    // Asserting the link's href proved nothing: every export in this application pointed at the
    // right URL and still failed, because a browser navigation carries no bearer token. The
    // only assertion worth making is that a file arrives.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-intake').click(),
    ])
    expect(download.suggestedFilename()).toBe('submissions.csv')
  })
})

test.describe('where to find a team that needs chasing (E27-S03 acceptance 4)', () => {
  test('names the room and coach beside the team', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    const needsChasing = page.getByRole('table', { name: 'Submissions needing chasing' })
    const beta = needsChasing.getByRole('row', { name: /Team Beta/ })
    await expect(beta).toContainText('Ada Room')
    await expect(beta).toContainText('Margaret Hamilton')
  })

  test('says "no room" for a team nobody has placed, rather than leaving it blank', async ({ page }) => {
    // A blank cell reads as a rendering fault. "No room" is a fact an organiser acts on (P5.1).
    await signIn(page)
    await page.goto('/intake')

    const needsChasing = page.getByRole('table', { name: 'Submissions needing chasing' })
    await expect(needsChasing.getByRole('row', { name: /Team Gamma/ })).toContainText('no room')
  })
})

test.describe('getting each team its code (E34)', () => {
  test('counts the teams NOT reached, and names them', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    // Three seeded teams, none sent anything yet.
    await expect(page.getByTestId('unreached-count')).toHaveText('3')
    await expect(page.getByRole('row', { name: /Team Alpha/ }).last())
      .toContainText('Not attempted')
  })

  test('issues and prepares, then says nothing was actually sent', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await page.getByRole('button', { name: /Issue and send to every team/ }).click()

    // The placeholder provider composes and transmits nothing, and says so rather than
    // claiming a delivery nobody made.
    await expect(page.getByText(/No mail provider is configured, so nothing was sent/))
      .toBeVisible()
    await expect(page.getByText(/exist only on this screen/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Download the 3 message/ })).toBeVisible()

    // And the worklist empties, because every team now has a code prepared.
    await expect(page.getByTestId('unreached-count')).toHaveText('0')
  })
})

test.describe('every entry, not only the failing ones (E39)', () => {
  test('lists a VALID submission, which the dashboard never itemised', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    const entries = page.getByRole('table', { name: 'Every current entry' })
    // Team Alpha is valid, so it appears here and NOT in "needs chasing".
    await expect(entries.getByRole('row', { name: /Team Alpha/ })).toContainText('VALID')
    await expect(page.getByRole('table', { name: 'Submissions needing chasing' })
      .getByText('Team Alpha')).toHaveCount(0)
  })

  test('filters on the server, and says so when nothing matches', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await page.getByLabel('Filter by status').selectOption('PENDING')
    await expect(page.getByText('No entries match that filter.')).toBeVisible()

    await page.getByLabel('Filter by status').selectOption('VALID')
    await expect(page.getByRole('table', { name: 'Every current entry' })
      .getByRole('row', { name: /Team Alpha/ })).toBeVisible()
  })
})

test.describe('pre-flight checks from the entries table (E46-S02)', () => {
  test('a valid entry is "Not checked" until an organiser runs the checks, then no longer is', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    const entries = page.getByRole('table', { name: 'Every current entry' })
    const alpha = entries.getByRole('row', { name: /Team Alpha/ })
    await expect(alpha).toContainText('Not checked')
    // An entry that has not passed tier 1 cannot be pre-flighted, and says why.
    await expect(entries.getByRole('row', { name: /Team Beta/ })).toContainText('Waits for tier 1')
    await expect(entries.getByRole('row', { name: /Team Beta/ }).getByRole('button', { name: /Run/ }))
      .toHaveCount(0)

    await alpha.getByRole('button', { name: 'Run checks' }).click()

    // Queued at once; the drain may already have started or finished it by the time the page
    // refetches, so the assertion is that the entry is no longer unchecked.
    await expect(alpha).not.toContainText('Not checked')
    await expect(alpha).toContainText(/Queued|Checking|Could not be checked|READY|PROBLEMS|did not finish/)

    // And wait for it to settle, so its scan and probe writes cannot land after the next
    // journey has re-seeded the database. The fixture repository does not exist, so the
    // honest outcome is "could not be checked" — never a failure blamed on the team.
    // The page does not poll, so settle is observed by reloading until the row says so.
    await expect.poll(async () => {
      await page.reload()
      return page.getByRole('table', { name: 'Every current entry' })
        .getByRole('row', { name: /Team Alpha/ }).textContent()
    }, { timeout: 60_000, intervals: [1000, 2000, 3000] }).toMatch(/Could not be checked|did not finish/)
  })
})

test.describe('handing a team its code, and correcting a team (E47-S01, E48-S01)', () => {
  test('replaces a code with a reason and says the old one has stopped working', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await page.getByRole('button', { name: /Issue and send to every team/ }).click()
    await expect(page.getByTestId('unreached-count')).toHaveText('0')

    const teamSelect = page.getByLabel('Team', { exact: true })
    const option = teamSelect.locator('option', { hasText: 'Team Alpha' })
    await teamSelect.selectOption(await option.getAttribute('value') ?? '')
    const replace = page.getByRole('button', { name: /Replace this team's code/ })
    await expect(replace).toBeDisabled()
    await page.getByLabel(/Why the code is being replaced/).fill('team lost it')
    await replace.click()

    await expect(page.getByText(/previous code has stopped working/)).toBeVisible()
    await expect(page.getByText(/Token for Team Alpha/)).toBeVisible()
  })

  test('renames a team from its token row, naming a collision when there is one', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await page.getByRole('button', { name: /Issue and send to every team/ }).click()
    await expect(page.getByTestId('unreached-count')).toHaveText('0')

    const tokens = page.getByRole('table', { name: 'Submission tokens' })
    const alphaRow = tokens.getByRole('row', { name: /Team Alpha/ })
    await alphaRow.getByRole('button', { name: /^Edit team/ }).click()
    const form = alphaRow.getByRole('form', { name: /^Edit team/ })
    await form.getByLabel('Team name').fill('team beta')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('alert')).toContainText(/collides with the existing team "Team Beta"/)

    await alphaRow.getByRole('button', { name: /^Edit team/ }).click()
    await form.getByLabel('Team name').fill('Team Alpha Prime')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('table', { name: 'Submission tokens' })).toContainText('Team Alpha Prime')
  })
})

test.describe('an admin can read a code back, audited (E47-S02, ADR 0005)', () => {
  test('reveals the current code from the token row and says it was read back, not reissued', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')
    await page.getByRole('button', { name: /Issue and send to every team/ }).click()
    await expect(page.getByTestId('unreached-count')).toHaveText('0')

    const alphaRow = page.getByRole('table', { name: 'Submission tokens' })
      .getByRole('row', { name: /Team Alpha/ })
    await alphaRow.getByRole('button', { name: 'Reveal' }).click()

    await expect(page.getByText(/read back under your name/)).toBeVisible()
    await expect(page.getByText(/Token for Team Alpha/)).toBeVisible()
    await expect(page.locator('code', { hasText: /^crs_/ })).toBeVisible()
  })
})

test.describe('the links participants use, and who is not there yet (E50)', () => {
  test('shows a QR code for registration and submission, and the chase list', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await expect(page.getByRole('heading', { name: 'Links for participants' })).toBeVisible()
    await expect(page.getByRole('img', { name: /QR code for Register a team/ })).toBeVisible()
    await expect(page.getByRole('img', { name: /QR code for Submit an entry/ })).toBeVisible()

    // The seed's three teams all hold entries, so nobody is outstanding.
    await expect(page.getByRole('heading', { name: /Not there yet/ })).toBeVisible()
  })
})

test.describe('the code handout (migration 103)', () => {
  /*
   * Walked here because the first real handout at the event reached one person per team: the
   * query read `contact_email` and one member registers per team by design. The panel now
   * reports PEOPLE, and the control that corrects a short send is the same control that could
   * re-mail a credential to everyone — so what matters on screen is that it is OFF by default.
   */
  test('reports who is waiting without sending anything', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    await expect(page.getByRole('heading', { name: 'Send the submission codes' })).toBeVisible()
    await page.getByRole('button', { name: 'Check who is waiting' }).click()

    // A count, whatever it is — the check reads state and writes none.
    await expect(page.getByTestId('handout-waiting')).toBeVisible()
    await expect(page.getByText(/registered teams have not been sent their code/)).toBeVisible()
  })

  test('the re-send is OFF until an organiser asks for it', async ({ page }) => {
    await signIn(page)
    await page.goto('/intake')

    const resend = page.getByLabel(/Send again to teams already sent/)
    await expect(resend).not.toBeChecked()
    await resend.check()
    await expect(resend).toBeChecked()
  })
})
