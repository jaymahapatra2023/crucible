/**
 * E2E — the go/no-go gate (E11-S03).
 *
 * The epic's whole purpose in one journey: an uncalibrated system, or one whose gate was failed,
 * must not rank submissions — and must say so in words an organiser can act on rather than
 * failing silently or looking broken.
 */
import { expect, test, type Page } from '@playwright/test'
import { E2E_USERS, seedE2EUsers } from './support/seed.js'
import { seedScoredRun, seedGateDecision, type SeededScoring } from './support/scoringSeed.js'

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

test.describe('an uncalibrated system', () => {
  test.beforeEach(async () => { await seedGateDecision('NONE') })

  test('does NOT present silence as permission', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await expect(page.getByTestId('gate-undecided'))
      .toContainText('This system has not been calibrated')
    await expect(page.getByTestId('gate-ok')).toHaveCount(0)
  })

  test('says evidence gathering is still available', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)
    await expect(page.getByTestId('gate-undecided'))
      .toContainText('Evidence gathering remains available')
  })

  test('REFUSES to compute a ranking through the API', async ({ request, baseURL }) => {
    const login = await request.post(`${baseURL}/api/v1/auth/login`, {
      data: { email: E2E_USERS.admin.email, password: E2E_USERS.admin.password },
    })
    const { data } = await login.json() as { data: { token: string } }

    const res = await request.post(
      `${baseURL}/api/v1/scoring/runs/${seeded.runIndexId}/ranking`,
      { headers: { authorization: `Bearer ${data.token}` } })

    expect(res.status()).toBe(412)
    expect(await res.text()).toMatch(/No go\/no-go decision has been recorded/)
  })
})

test.describe('a FAILED gate', () => {
  test.beforeEach(async () => { await seedGateDecision('NO_GO') })

  test('says ranking is disabled, why, and what the fallback is', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    const banner = page.getByTestId('gate-no-go')
    await expect(banner).toContainText('Ranking is disabled')
    await expect(banner).toContainText('below the recorded threshold')
    await expect(banner).toContainText('fully human judging')
  })

  test('REFUSES to rank, quoting the fallback plan', async ({ request, baseURL }) => {
    const login = await request.post(`${baseURL}/api/v1/auth/login`, {
      data: { email: E2E_USERS.admin.email, password: E2E_USERS.admin.password },
    })
    const { data } = await login.json() as { data: { token: string } }

    const res = await request.post(
      `${baseURL}/api/v1/scoring/runs/${seeded.runIndexId}/ranking`,
      { headers: { authorization: `Bearer ${data.token}` } })

    expect(res.status()).toBe(412)
    expect(await res.text()).toMatch(/gathers evidence only/)
  })
})

test.describe('a PASSED gate', () => {
  test.beforeEach(async () => { await seedGateDecision('GO') })

  test('records that the system was shown fit, and by whom', async ({ page }) => {
    await signIn(page)
    await page.goto(`/review/runs/${seeded.runIndexId}`)

    await expect(page.getByTestId('gate-ok')).toContainText('chair@test.local')
    await expect(page.getByTestId('gate-ok')).toContainText('0.91')
  })

  test('permits ranking again', async ({ request, baseURL }) => {
    const login = await request.post(`${baseURL}/api/v1/auth/login`, {
      data: { email: E2E_USERS.admin.email, password: E2E_USERS.admin.password },
    })
    const { data } = await login.json() as { data: { token: string } }

    const res = await request.post(
      `${baseURL}/api/v1/scoring/runs/${seeded.runIndexId}/ranking`,
      { headers: { authorization: `Bearer ${data.token}` } })

    // Past the gate. It may still fail for its own reasons, but not for the gate.
    expect(res.status()).not.toBe(412)
  })
})
