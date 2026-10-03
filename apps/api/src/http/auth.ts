/**
 * Authentication and authorisation (P8.1, P8.5, E09-S03).
 *
 * P8.1 is enforced structurally: `requireAuth` is registered as a global hook and a route is
 * unauthenticated only by appearing in the explicitly declared allow-list below. There is no way
 * for a route to end up public by accident of mount ordering — the failure mode the principle
 * was written against.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../lib/appError.js'
import { enrichContext } from '../lib/correlation.js'
import { createLogger } from '../lib/logger.js'
import { verifyToken } from '../lib/jwt.js'
import { loadEnv } from '../config/env.js'
import { recordAudit } from '../lib/ports/auditPort.js'

const log = createLogger('governance', 'auth')

export const ROLES = ['viewer', 'reviewer', 'organiser', 'admin'] as const
export type Role = (typeof ROLES)[number]

/** Higher rank subsumes lower. `organiser` and above may approve, freeze, override, finalise. */
const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, organiser: 2, admin: 3 }

export interface Principal {
  userId: string
  email: string
  role: Role
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

/**
 * The complete set of unauthenticated routes (P8.1).
 *
 * Entries are `METHOD /path`, matched exactly or as a prefix when the path ends in `/*`.
 * **Method-specific on purpose:** `POST /api/v1/submissions` is a team submitting an entry with
 * a submission token, while `GET /api/v1/submissions` lists every team's name, contact and
 * repository. A path-only allow-list would exempt both, and the second is not public.
 *
 * Adding an entry here is a reviewed decision, not a side effect.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  'GET /health',
  'GET /ready',
  'GET /metrics',
  'POST /api/v1/auth/login',
  // Browsers cannot set an Authorization header on a WebSocket handshake. The token travels as
  // a query parameter and is verified in websocketRoutes.ts — a named alternate authentication
  // factor at its mount point, which is what P8.1 requires, not an absence of authentication.
  'GET /ws/progress',
  // Teams have no Crucible account by design (P8.2). `POST /submissions` authenticates with a
  // scoped, revocable submission token verified at its mount point; `/submissions/status` is
  // public because a team needs to know whether intake is open before it has a token in hand,
  // and it carries no team or submission data.
  'POST /api/v1/submissions',
  'GET /api/v1/submissions/status',
  // A team checking their OWN entry (E17-S03). Same factor, same mount point. The team id comes
  // from the verified token, so this endpoint has no parameter that could name another team —
  // which is what makes a team-scoped read safe to expose without an account.
  'GET /api/v1/submissions/mine',
  // The same reasoning: a team filling in the submission form has to say which challenge they
  // are entering, and has no account with which to read the challenge list. This returns the
  // id and name of OPEN challenges only — nothing a challenge still being drafted would leak.
  'GET /api/v1/challenges/open',
  // Teams have no account by design; the published rubric must be readable before the event.
  'GET /api/v1/rubrics/published/*',
  // Participants register their own teams (E44). `start` takes one email and returns nothing
  // about the roster. Everything under a link is scoped by that link, verified at its mount
  // point — the same factor-at-mount-point arrangement as a submission token — and NO route
  // here returns a list of participants or teams (II.1); a test asserts it.
  'POST /api/v1/register/start',
  'GET /api/v1/register/*',
  'POST /api/v1/register/*',
]

export function isPublicRoute(method: string, path: string): boolean {
  const clean = path.split('?')[0] ?? path
  const verb = method.toUpperCase()

  return PUBLIC_ROUTES.some((entry) => {
    const [entryMethod, entryPath] = entry.split(' ') as [string, string]
    if (entryMethod !== verb) return false
    return entryPath.endsWith('/*')
      ? clean.startsWith(entryPath.slice(0, -1))
      : clean === entryPath
  })
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (isPublicRoute(req.method, req.url)) return

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'A bearer token is required for this request.')
    }

    const result = verifyToken(header.slice(7), loadEnv().JWT_SECRET)
    if (!result.ok) {
      log.warn('token rejected', { reason: result.reason, path: req.url })
      throw new AppError(
        'UNAUTHENTICATED',
        result.reason === 'expired'
          ? 'Your session has expired. Sign in again.'
          : 'The supplied token is not valid.',
      )
    }

    const role = (ROLES as readonly string[]).includes(result.claims.role)
      ? (result.claims.role as Role)
      : 'viewer'

    req.principal = { userId: result.claims.sub, email: result.claims.email, role }
    enrichContext({ actor: result.claims.email })
  })
}

/** The acting principal, or a thrown 401. Services never guess an actor. */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) {
    throw new AppError('UNAUTHENTICATED', 'This request is not authenticated.')
  }
  return req.principal
}

/**
 * Route guard requiring at least `minimum`. Denials are audited (E09-S03 acceptance 3) — an
 * attempt to approve a rubric without the role is exactly the kind of event an investigation
 * later needs to find.
 */
export function requireRole(minimum: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const principal = principalOf(req)
    if (RANK[principal.role] < RANK[minimum]) {
      await recordAudit({
        actor: principal.email,
        action: 'authorization.denied',
        subjectType: 'route',
        subjectId: `${req.method} ${req.url}`,
        payload: { required: minimum, actual: principal.role },
      })
      throw new AppError(
        'FORBIDDEN',
        `This action requires the '${minimum}' role or higher; your role is '${principal.role}'.`,
      )
    }
  }
}

export function hasRole(principal: Principal, minimum: Role): boolean {
  return RANK[principal.role] >= RANK[minimum]
}
