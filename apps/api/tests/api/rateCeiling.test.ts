/**
 * Circuit-breaker ceilings (E41).
 *
 * The first draft of this proposed rate limits as protection, with budgets low enough to be
 * "protective" — which means low enough for a team resubmitting at a deadline to hit one. That was
 * the wrong trade: a 429 shown to an entrant three minutes before the window closes costs more
 * than every risk it guards against.
 *
 * So what is tested here is mostly the OPPOSITE of a limiter's usual tests: that legitimate volume
 * passes, that polling is unlimited, that a failure lets the request through, and that one flag
 * removes the whole thing. The one place a real limit is asserted is `/auth/login`, which no
 * participant ever touches.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { closeApp, getApp } from '../support/testServer.js'
import { ceilingTrips, resetRateLimit, CEILING_ROUTES, LIMITED_PRIVATE, UNLIMITED } from '../../src/http/rateLimit.js'
import {
  getNumber, invalidateConfig, setConfig, setFlag,
} from '../../src/modules/platform/services/configService.js'
import { isPublicRoute, PUBLIC_ROUTES } from '../../src/http/auth.js'

let app: FastifyInstance

const login = (email = 'nobody@test.local') => app.inject({
  method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'wrong-password-entirely' },
})

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  resetRateLimit()
  app = await getApp()
})

afterAll(async () => closeApp())

describe('what a participant experiences', () => {
  it('does not limit the status read teams poll', async () => {
    // Polling is the behaviour the system wants: a team watching for the window to open.
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/submissions/status' })
      expect(res.statusCode).not.toBe(429)
    }
  })

  it('does not limit a team checking their own entry', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/submissions/mine',
        headers: { authorization: 'Bearer crs_not-a-real-token' },
      })
      expect(res.statusCode).not.toBe(429)
    }
  })

  it('does not limit reading the open challenges', async () => {
    for (let i = 0; i < 40; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/challenges/open' })).statusCode)
        .not.toBe(429)
    }
  })
})

describe('the ceiling is a breaker, not a policy', () => {
  it('lets a resubmitting team through many times over', async () => {
    // Thirty submissions in an hour is a team fixing a build error every two minutes. The ceiling
    // is ten times that, so this must not trip.
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/submissions',
        headers: { authorization: 'Bearer crs_not-a-real-token' },
        payload: { contactEmail: 'a@b.test', challengeId: 1, repoUrl: 'https://github.com/a/b', buildMethod: 'COMMAND', buildCommand: 'x' },
      })
      // Refused for being unauthenticated or invalid — never for volume.
      expect(res.statusCode).not.toBe(429)
    }
  })

  it('DOES stop a loop, once the ceiling is reached', async () => {
    // Lowered for the test. The point is that the mechanism works, not that 300 is reachable.
    await setConfig('http.ceiling_submissions_per_hour', 3, 'test')
    invalidateConfig()

    const send = () => app.inject({
      method: 'POST', url: '/api/v1/submissions',
      headers: { authorization: 'Bearer crs_looping-client' },
      payload: { contactEmail: 'a@b.test', challengeId: 1, repoUrl: 'https://github.com/a/b', buildMethod: 'COMMAND', buildCommand: 'x' },
    })

    for (let i = 0; i < 3; i++) expect((await send()).statusCode).not.toBe(429)
    const stopped = await send()
    expect(stopped.statusCode).toBe(429)
    expect(stopped.headers['retry-after']).toBeDefined()
  })

  it('records the trip for the health screen, without any identifier (S01 acceptance 7)', async () => {
    await setConfig('http.ceiling_submissions_per_hour', 1, 'test')
    invalidateConfig()
    const send = () => app.inject({
      method: 'POST', url: '/api/v1/submissions',
      headers: { authorization: 'Bearer crs_looping-client' },
      payload: { contactEmail: 'a@b.test', challengeId: 1, repoUrl: 'https://github.com/a/b', buildMethod: 'COMMAND', buildCommand: 'x' },
    })
    expect(ceilingTrips()).toEqual([])
    await send()
    await send()
    await send()

    const trips = ceilingTrips()
    expect(trips).toEqual([{ route: 'POST /api/v1/submissions', count: 2, lastAt: expect.any(Date) }])
    expect(JSON.stringify(trips)).not.toContain('looping-client')
  })

  it('says it is a safety limit and NOT a rejection of the entry', async () => {
    await setConfig('http.ceiling_submissions_per_hour', 1, 'test')
    invalidateConfig()
    const send = () => app.inject({
      method: 'POST', url: '/api/v1/submissions',
      headers: { authorization: 'Bearer crs_looping-client-2' },
      payload: { contactEmail: 'a@b.test', challengeId: 1, repoUrl: 'https://github.com/a/b', buildMethod: 'COMMAND', buildCommand: 'x' },
    })
    await send()
    const message = (await send()).json() as { error: { message: string } }

    // A participant reading this must not think their entry was refused.
    expect(message.error.message).toMatch(/safety limit, not a rejection/)
    expect(message.error.message).toMatch(/nothing is wrong with your submission/)
    expect(message.error.message).toMatch(/tell an organiser/)
  })

  it('counts per token, so one team cannot exhaust another behind the same NAT', async () => {
    await setConfig('http.ceiling_submissions_per_hour', 2, 'test')
    invalidateConfig()
    const send = (token: string) => app.inject({
      method: 'POST', url: '/api/v1/submissions',
      headers: { authorization: `Bearer ${token}` },
      payload: { contactEmail: 'a@b.test', challengeId: 1, repoUrl: 'https://github.com/a/b', buildMethod: 'COMMAND', buildCommand: 'x' },
    })

    await send('crs_team-one')
    await send('crs_team-one')
    expect((await send('crs_team-one')).statusCode).toBe(429)
    // A different team, same IP: unaffected.
    expect((await send('crs_team-two')).statusCode).not.toBe(429)
  })
})

describe('the one limit set for security', () => {
  it('throttles attempts against ONE ACCOUNT, which is the actual attack', async () => {
    // Stuffing one account needs thousands of guesses; a forgetful person needs about five.
    await setConfig('http.ceiling_login_per_15min', 3, 'test')
    invalidateConfig()

    for (let i = 0; i < 3; i++) expect((await login('target@test.local')).statusCode).toBe(401)
    expect((await login('target@test.local')).statusCode).toBe(429)
  })

  it('does NOT punish a different account from the same network', async () => {
    // The first draft used one ceiling for IP and email together at 20, and the test suite tripped
    // it in seconds — a fair stand-in for ten organisers behind one office NAT.
    await setConfig('http.ceiling_login_per_15min', 2, 'test')
    invalidateConfig()

    for (let i = 0; i < 2; i++) await login('exhausted@test.local')
    expect((await login('exhausted@test.local')).statusCode).toBe(429)
    // Same IP, different person: unaffected.
    expect((await login('somebody-else@test.local')).statusCode).toBe(401)
  })

  it('keeps the per-IP ceiling far above any group of people', async () => {
    // A breaker, not a policy: it exists to stop a script, and a shared network must never reach it.
    const perIp = await getNumber('http.ceiling_login_per_ip_15min')
    expect(perIp).toBeGreaterThanOrEqual(500)
  })
})

describe('when it goes wrong, it goes wrong safely', () => {
  it('one flag removes every ceiling immediately', async () => {
    await setConfig('http.ceiling_submissions_per_hour', 1, 'test')
    await setFlag('feature.http.rate_limit', false, 'test')
    invalidateConfig()

    const send = () => app.inject({
      method: 'POST', url: '/api/v1/submissions',
      headers: { authorization: 'Bearer crs_flag-off' },
      payload: { contactEmail: 'a@b.test', challengeId: 1, repoUrl: 'https://github.com/a/b', buildMethod: 'COMMAND', buildCommand: 'x' },
    })
    for (let i = 0; i < 5; i++) expect((await send()).statusCode).not.toBe(429)
  })
})

describe('every public route has a decision (E41-S02 acceptance 6)', () => {
  /**
   * An allow-list entry may be a wildcard (`POST /api/v1/register/*`) covering several concrete
   * routes, each of which needs its own ceiling. A wildcard is decided when at least one ceiling
   * or unlimited entry sits under it; an exact entry must appear exactly.
   */
  const decided = [...CEILING_ROUTES, ...UNLIMITED]
  const covers = (entry: string): boolean => {
    if (decided.includes(entry)) return true
    if (!entry.endsWith('/*')) return false
    const prefix = entry.slice(0, -1)
    return decided.some((d) => d.startsWith(prefix))
  }

  it('is either given a ceiling or deliberately listed as unlimited', () => {
    // The same shape as the P8.1 allow-list pin: a new public route cannot be added without
    // somebody choosing. An oversight fails here rather than at the event.
    const undecided = PUBLIC_ROUTES.filter((route) => !covers(route))
    expect(undecided).toEqual([])
  })

  it('does not claim a ceiling for a route that is not public', () => {
    for (const route of CEILING_ROUTES) {
      const [method, path] = route.split(' ') as [string, string]
      // ADR 0005 names the one authenticated route that carries a ceiling for security.
      if (LIMITED_PRIVATE.includes(route)) continue
      expect(isPublicRoute(method, path), `${route} is limited but not public`).toBe(true)
    }
  })
})

describe('the hook runs where the body exists (E41, corrected)', () => {
  it('counts the per-email bucket at all', async () => {
    // Registered on `onRequest` first, which runs BEFORE body parsing — so `req.body` was always
    // undefined and this bucket was never counted. The control existed and did nothing.
    await setConfig('http.ceiling_login_per_15min', 1, 'test')
    invalidateConfig()

    await login('proof@test.local')
    const refused = await login('proof@test.local')

    expect(refused.statusCode).toBe(429)
    expect((refused.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
  })

  it('still runs before authentication, so failed sign-ins are counted', async () => {
    // A limiter after auth would never see the requests it exists to stop.
    await setConfig('http.ceiling_login_per_15min', 2, 'test')
    invalidateConfig()

    // Every one of these is a 401 — an unauthenticated attempt — and they still accumulate.
    expect((await login('never-exists@test.local')).statusCode).toBe(401)
    expect((await login('never-exists@test.local')).statusCode).toBe(401)
    expect((await login('never-exists@test.local')).statusCode).toBe(429)
  })
})
