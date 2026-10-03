import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { E2E_USERS, type E2ERole } from './seed.js'

/** Sign in through the form, as the role says. Every journey starts here; one definition. */
export async function signInAs(page: Page, role: E2ERole = 'admin'): Promise<void> {
  const user = E2E_USERS[role]
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
}

/** A bearer token for API-level probes, obtained the way the app obtains one. */
export async function bearer(request: APIRequestContext, baseURL: string, role: E2ERole): Promise<string> {
  const user = E2E_USERS[role]
  const res = await request.post(`${baseURL}/api/v1/auth/login`, { data: { email: user.email, password: user.password } })
  const { data } = await res.json() as { data: { token: string } }
  return data.token
}

/** True when the page cannot be scrolled sideways: the phone-width rule (E50-S06). */
export async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}
