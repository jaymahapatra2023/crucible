/**
 * Circuit-breaker ceilings for public routes (E41).
 *
 * **This is not a rate-limiting policy and must not become one.** Every ceiling here sits an order
 * of magnitude above the most demanding legitimate use, because the cost of a participant seeing a
 * refusal three minutes before a deadline exceeds every risk this guards against. A caller who
 * trips one is, by construction, not submitting — they are looping.
 *
 * Two things make that stance affordable rather than reckless:
 *
 *  1. **Participants never touch `/auth/login`.** It is staff-only, so a strict limit there costs
 *     entrants nothing and still stops credential stuffing — the one real attack this system is
 *     exposed to. That is the only limit here set for security.
 *  2. **`POST /submissions` clones a repository per call.** A runaway script exhausts disk and
 *     workers without anyone intending harm, and a ceiling no human can reach still stops it.
 *
 * Reads that teams poll are **deliberately unlimited**: polling is the behaviour the system wants,
 * and `/submissions/status` costs one cheap query.
 *
 * In-process by design. Crucible runs as a single API process; a second instance would need a
 * shared store, and the honest way to find that out is this comment rather than a silent halving
 * of every ceiling.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createLogger } from '../lib/logger.js'
import { getNumber, isEnabled } from '../modules/platform/services/configService.js'

const log = createLogger('platform', 'rateLimit')

/** How a route's ceiling is found, and the window it applies over. */
interface Ceiling {
  /** Config key holding the count. */
  key: string
  windowMs: number
  /** Identify the caller. Returning null means "do not count this call". */
  identify: (req: FastifyRequest) => string | null
}

const HOUR = 3_600_000
const FIFTEEN_MINUTES = 900_000

/** A submission token identifies a team far better than an IP does behind conference NAT. */
const byToken = (req: FastifyRequest): string => {
  const header = req.headers.authorization
  const token = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : ''
  // The token is hashed into the bucket key: the key is held in memory and must not be the
  // credential itself (P8.3).
  return token === '' ? `ip:${req.ip}` : `tok:${fingerprint(token)}`
}

/**
 * Ceilings by `METHOD /path`. A route absent from here is **unlimited**, which is a decision, and
 * `UNLIMITED` records the ones made deliberately so a test can tell them from an oversight.
 */
const CEILINGS: Record<string, Ceiling> = {
  'POST /api/v1/submissions': {
    key: 'http.ceiling_submissions_per_hour', windowMs: HOUR, identify: byToken,
  },
  /*
   * Two buckets with DIFFERENT ceilings, because they answer different questions.
   *
   * The first draft used one number for both and set it at 20. The test suite tripped it within
   * seconds — and the test suite is a fair stand-in for ten organisers behind one office NAT.
   * A per-IP ceiling is shared by every honest user of a shared network, so it must be a breaker;
   * a per-email ceiling is the actual security control and can be strict without anyone noticing.
   */
  'POST /api/v1/auth/login': {
    key: 'http.ceiling_login_per_ip_15min',
    windowMs: FIFTEEN_MINUTES,
    identify: (req) => `ip:${req.ip}`,
  },
  /*
   * Reveal (E47-S02, ADR 0005): the second limit set for security rather than as a breaker,
   * beside login. Per credential — the admin's own bearer token, fingerprinted — so one
   * compromised session cannot walk the whole table in a minute.
   */
  'POST /api/v1/submissions/tokens/:id/reveal': {
    key: 'http.ceiling_token_reveal_per_hour', windowMs: HOUR, identify: byToken,
  },
  /*
   * Registration (E44). A team of eight with mistyped addresses and restarts is ~40 calls in an
   * hour; the ceiling is ten times that. `start` has no link yet so it counts by IP; the
   * link-scoped calls count by the link, so one team's typing cannot exhaust another's.
   */
  /*
   * A Discord username check inside a registration (E49-S02): one call per attempt at typing
   * a username, counted by the link so one team's typing cannot exhaust another's. Shares the
   * registration ceiling; a person retyping a username forty times is not registering.
   */
  'POST /api/v1/register/:token/discord': {
    key: 'http.ceiling_registration_per_hour', windowMs: HOUR, identify: byLinkParam,
  },
  'POST /api/v1/register/start': {
    key: 'http.ceiling_registration_per_hour', windowMs: HOUR, identify: (req) => `ip:${req.ip}`,
  },
  /*
   * Confirming your own details (migration 104). Counted by IP and sharing the registration
   * ceiling, which at a venue is one shared address for everybody — so it is a breaker against a
   * script writing claims in a loop, not a limit any queue of students could reach.
   */
  'POST /api/v1/confirm': {
    key: 'http.ceiling_registration_per_hour', windowMs: HOUR, identify: (req) => `ip:${req.ip}`,
  },
  /* A coach tapping their name (migration 105). Same breaker, same reasoning. */
  'POST /api/v1/coach/confirm': {
    key: 'http.ceiling_registration_per_hour', windowMs: HOUR, identify: (req) => `ip:${req.ip}`,
  },
  'POST /api/v1/register/:token/lookup': {
    key: 'http.ceiling_registration_per_hour', windowMs: HOUR, identify: byLinkParam,
  },
  'POST /api/v1/register/:token/confirm': {
    key: 'http.ceiling_registration_per_hour', windowMs: HOUR, identify: byLinkParam,
  },
}

/** The link token from the route, fingerprinted — never held in memory as itself (P8.3). */
function byLinkParam(req: FastifyRequest): string {
  const token = (req.params as { token?: unknown } | undefined)?.token
  return typeof token === 'string' && token !== '' ? `link:${fingerprint(token)}` : `ip:${req.ip}`
}

/** Public routes with no ceiling, listed so the coverage test can prove it was a decision. */
export const UNLIMITED: readonly string[] = [
  'GET /health',
  'GET /ready',
  'GET /metrics',
  'GET /ws/progress',
  // Teams poll these. Polling is wanted behaviour and each is one cheap query.
  'GET /api/v1/submissions/status',
  'GET /api/v1/submissions/mine',
  'GET /api/v1/challenges/open',
  'GET /api/v1/rubrics/published/*',
  // Reads inside a registration: what the link resolves to, and whether a name collides. A
  // registrant checks the name on every keystroke, and that is wanted.
  'GET /api/v1/register/*',
  // The coach list (migration 105): thirty-four names, one cheap query, fetched once when the
  // page opens. It carries no address and no team, so there is nothing a ceiling would protect.
  'GET /api/v1/coach/names',
]

/**
 * Authenticated routes that carry a ceiling anyway (ADR 0005). The coverage test allows exactly
 * these, so a second one has to be a decision rather than a habit.
 */
export const LIMITED_PRIVATE: readonly string[] = ['POST /api/v1/submissions/tokens/:id/reveal']

export const CEILING_ROUTES = Object.keys(CEILINGS)

interface Bucket {
  count: number
  resetAt: number
}

/** Bounded so a flood of distinct identifiers cannot grow this without limit. */
const MAX_BUCKETS = 50_000
const buckets = new Map<string, Bucket>()

/**
 * Every refusal, by route, for the operator health screen (E41-S01 acceptance 7).
 *
 * A tripped breaker means something is looping somewhere, and a log line an organiser is not
 * reading at 23:00 is not "surfaced". Counts only — no identifier is kept (P8.3).
 */
interface Trip { count: number; lastAt: Date }
const trips = new Map<string, Trip>()

export interface CeilingTrip { route: string; count: number; lastAt: Date }

export function ceilingTrips(): CeilingTrip[] {
  return [...trips].map(([route, t]) => ({ route, count: t.count, lastAt: t.lastAt }))
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
}

function recordTrip(route: string): void {
  const existing = trips.get(route)
  if (existing) {
    existing.count += 1
    existing.lastAt = new Date()
  } else {
    trips.set(route, { count: 1, lastAt: new Date() })
  }
}

/** Test seam — clears every bucket and every recorded trip. */
export function resetRateLimit(): void {
  buckets.clear()
  trips.clear()
}

function fingerprint(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return String(hash >>> 0)
}

/** Count one hit. Returns the seconds to wait when the ceiling is already reached. */
function hit(bucketKey: string, limit: number, windowMs: number): number | null {
  const now = Date.now()
  const existing = buckets.get(bucketKey)

  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) sweep(now)
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs })
    return null
  }

  if (existing.count >= limit) {
    return Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
  }
  existing.count += 1
  return null
}

/** Drop expired buckets. Called only when the map is full, so it costs nothing in normal running. */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/**
 * The hook. Returns true when the request was refused, so the caller stops.
 *
 * Every failure mode here lets the request **through**: a missing config key, an unreadable flag,
 * anything unexpected. A breaker that fails closed would take down submissions to protect them.
 */
export async function applyCeiling(
  req: FastifyRequest, reply: FastifyReply,
): Promise<boolean> {
  // The route PATTERN (`/register/:token/confirm`), not the concrete URL: a parameterised
  // route can only be keyed by its pattern, and Fastify exposes it once routing has happened.
  const pattern = (req as { routeOptions?: { url?: string } }).routeOptions?.url
  const route = `${req.method.toUpperCase()} ${pattern ?? (req.url.split('?')[0] ?? req.url)}`
  const ceiling = CEILINGS[route]
  if (!ceiling) return false

  try {
    if (!(await isEnabled('feature.http.rate_limit'))) return false

    const limit = await getNumber(ceiling.key)
    const identity = ceiling.identify(req)
    if (identity === null) return false

    // Login counts a second bucket per email, so one account cannot be ground down from many
    // addresses. The address is fingerprinted, never stored.
    const counted: Array<{ key: string; limit: number }> = [
      { key: `${route}|${identity}`, limit },
    ]
    if (route === 'POST /api/v1/auth/login') {
      const email = (req.body as { email?: unknown } | undefined)?.email
      if (typeof email === 'string' && email !== '') {
        counted.push({
          key: `${route}|email:${fingerprint(email.trim().toLowerCase())}`,
          limit: await getNumber('http.ceiling_login_per_15min'),
        })
      }
    }

    for (const { key, limit: ceilingFor } of counted) {
      const retryAfter = hit(key, ceilingFor, ceiling.windowMs)
      if (retryAfter === null) continue

      // Surfaced, because a tripped breaker means something is wrong somewhere and an organiser
      // needs to know. The identifier is a fingerprint; no token or address is logged (P8.3).
      log.warn('rate ceiling reached', { route, retryAfter, limit: ceilingFor })
      recordTrip(route)
      reply.status(429).header('retry-after', String(retryAfter)).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'This is a safety limit, not a rejection of your entry — far more requests '
            + `arrived from here than a person could make, so something is likely retrying in a `
            + `loop. Wait ${retryAfter} seconds and try once more. If this keeps happening, tell `
            + 'an organiser: nothing is wrong with your submission.',
        },
      })
      return true
    }
    return false
  } catch (err) {
    // Fails OPEN, always. Protecting submissions is not worth refusing them.
    log.error('rate ceiling could not be applied; allowing the request', { route, err })
    return false
  }
}

/**
 * Install the breaker.
 *
 * `preValidation`, not `onRequest`, and the difference was a real bug: `onRequest` runs **before
 * the body is parsed**, so `req.body` is always undefined there and the per-email login bucket was
 * silently never counted. The security control existed and did nothing — the exact defect this
 * codebase keeps finding, arrived at from a new direction.
 *
 * `preValidation` runs after parsing and **before** the `preHandler` that authenticates, which is
 * what the login ceiling needs: it must count attempts that FAIL to authenticate.
 *
 * The cost is that a looping client gets its body parsed before being refused. That is bounded by
 * the 5 MB body limit and is orders of magnitude cheaper than the git clone this exists to protect.
 */
export function registerRateCeilings(app: {
  addHook: (
    name: 'preValidation',
    fn: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  ) => void
}): void {
  app.addHook('preValidation', async (req, reply) => {
    // `applyCeiling` sends the 429 itself, so returning is enough to stop the request here.
    await applyCeiling(req, reply)
  })
}
