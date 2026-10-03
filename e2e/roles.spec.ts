/**
 * E2E — who may do what (P8.2), through the screens and the API.
 *
 * The matrix is the product's actual rule: viewer reads, reviewer reviews, organiser runs the
 * event, admin configures it. Every protected route refuses a signed-out caller with 401 and a
 * caller below the rank with 403 — never a 500, never a silent success.
 */
import { expect, test } from '@playwright/test'
import { E2E_USERS, seedE2EUsers, type E2ERole } from './support/seed.js'
import { bearer, signInAs } from './support/signIn.js'
import { seedIntake } from './support/intakeSeed.js'
import { seedGateDecision, seedScoredRun, type SeededScoring } from './support/scoringSeed.js'

const RANK: Record<E2ERole, number> = { viewer: 0, reviewer: 1, organiser: 2, admin: 3 }
const ROLES = Object.keys(E2E_USERS) as E2ERole[]

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'
const ROUTES: Array<[Method, string, E2ERole]> = [
  ['get', '/submissions/dashboard', 'viewer'], ['get', '/roster/readiness', 'viewer'],
  // The roster holds participants' addresses: reading it is an organiser act, not a viewer one.
  ['get', '/roster/participants', 'organiser'],
  ['get', '/scoring/runs', 'viewer'], ['get', '/platform/health', 'viewer'],
  ['get', '/review/runs/1/table', 'reviewer'], ['get', '/review/runs/1/coach-sheets', 'reviewer'],
  ['get', '/scoring/cohorts/x/final', 'reviewer'],
  ['post', '/submissions/tokens', 'organiser'], ['post', '/roster/participants', 'organiser'],
  ['post', '/roster/rooms', 'organiser'], ['post', '/roster/coaches', 'organiser'],
  ['post', '/scoring/runs', 'organiser'], ['post', '/submissions/reminders', 'organiser'],
  ['post', '/review/runs/1/coach-sheets/send', 'organiser'], ['post', '/submissions/window/lock', 'organiser'],
  ['post', '/review/runs/1/finalise', 'organiser'], ['post', '/scoring/runs/1/ranking', 'organiser'],
  ['post', '/governance/users', 'admin'], ['patch', '/platform/config/event.evaluation_date', 'admin'],
  ['patch', '/platform/flags/feature.notify.discord', 'admin'], ['post', '/submissions/tokens/1/reveal', 'admin'],
]

test.beforeAll(async () => { await seedE2EUsers() })

test.describe('the API matrix', () => {
  test('every protected route refuses a signed-out caller with 401', async ({ request, baseURL }) => {
    for (const [method, path] of ROUTES) {
      const res = await request[method](`${baseURL}/api/v1${path}`, { data: {} })
      expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(401)
    }
  })

  for (const role of ROLES) {
    test(`a ${role} is refused below rank with 403 and never 401 at or above it`, async ({ request, baseURL }) => {
      const token = await bearer(request, baseURL!, role)
      for (const [method, path, min] of ROUTES) {
        const res = await request[method](`${baseURL}/api/v1${path}`, { data: {}, headers: { authorization: `Bearer ${token}` } })
        const label = `${role} ${method.toUpperCase()} ${path}`
        if (RANK[role] < RANK[min]) expect(res.status(), label).toBe(403)
        else expect([401, 403, 500], label).not.toContain(res.status())
      }
    })
  }

  test('the public endpoints answer without a session, and an unknown link is 404 not 500', async ({ request, baseURL }) => {
    expect((await request.get(`${baseURL}/api/v1/challenges/open`)).status()).toBe(200)
    // Event settings are staff reading; the public pages get what they need through their own routes.
    expect((await request.get(`${baseURL}/api/v1/platform/event`)).status()).toBe(401)
    // An unknown link is refused as an unauthenticated one, by design: the link is the factor.
    expect([401, 404, 410]).toContain((await request.get(`${baseURL}/api/v1/register/crr_not-a-link`)).status())
    expect((await request.get(`${baseURL}/api/v1/rubrics/published/no-such-slug`)).status()).toBe(404)
    // Whether intake is open is public: a team needs it before it has a code in hand.
    expect((await request.get(`${baseURL}/api/v1/submissions/status`)).status()).toBe(200)
  })
})

test.describe('on the screens', () => {
  test('a viewer reads intake but is offered nothing that sends or issues', async ({ page }) => {
    await seedIntake()
    await signInAs(page, 'viewer')
    await page.goto('/intake')
    await expect(page.getByTestId('count-submitted')).toBeVisible()
    await expect(page.getByRole('button', { name: /Issue and send to every team/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Remind all/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Lock intake permanently/ })).toHaveCount(0)
  })

  test('a reviewer sees the coach sheets without the standing and without a send button', async ({ page }) => {
    const seeded: SeededScoring = await seedScoredRun()
    await seedGateDecision('GO')
    await signInAs(page, 'reviewer')
    await page.goto(`/review/runs/${seeded.runIndexId}/coach-sheets?scope=cutline`)
    await expect(page.locator('article.sheet')).toHaveCount(3)
    await expect(page.getByTestId('standing')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Email each coach their teams' })).toHaveCount(0)
    await expect(page.getByTestId('download-sheets')).toHaveCount(0)
  })

  test('a viewer opening the ranked field gets a stated refusal, not a blank page', async ({ page }) => {
    const seeded: SeededScoring = await seedScoredRun()
    await signInAs(page, 'viewer')
    await page.goto(`/review/runs/${seeded.runIndexId}`)
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(page.getByText(/reviewer|permission|allowed|forbidden/i).first()).toBeVisible()
  })

  test('the session bar names the role, so nobody acts under the wrong account', async ({ page }) => {
    await signInAs(page, 'organiser')
    await expect(page.getByText('organiser', { exact: true })).toBeVisible()
  })
})
