/**
 * Fastify application assembly.
 *
 * Order matters and is deliberate:
 *   1. correlation  — so every later line and query carries the request id (P9.2)
 *   2. error handler — so a failure anywhere below produces the P6.2 envelope
 *   3. auth          — registered globally; a route is public only by the explicit allow-list
 *                      in http/auth.ts, never by being mounted before this hook (P8.1)
 *   4. routes        — each module registers its own
 */
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import { loadEnv } from './config/env.js'
import { setLogLevel } from './lib/logger.js'
import { registerCorrelation } from './http/correlationHook.js'
import { registerErrorHandler } from './http/errorHandler.js'
import { registerAuth } from './http/auth.js'
import { registerRateCeilings } from './http/rateLimit.js'
import { registerRouteRecorder } from './http/routeRegistry.js'
import { registerWebsocket } from './http/websocketRoutes.js'
import { installAuditPort } from './modules/governance/services/auditService.js'
import { registerAuthRoutes } from './modules/governance/routes/authRoutes.js'
import { registerAuditRoutes } from './modules/governance/routes/auditRoutes.js'
import { registerRunRoutes } from './modules/platform/routes/runRoutes.js'
import { registerHealthRoutes } from './modules/platform/routes/healthRoutes.js'
import { registerMetricsRoutes } from './modules/platform/routes/metricsRoutes.js'
import { registerConfigRoutes } from './modules/platform/routes/configRoutes.js'
import { registerLlmRoutes } from './modules/llm/routes/llmRoutes.js'
import { registerChallengeRoutes } from './modules/challenges/routes/challengeRoutes.js'
import { registerRubricRoutes } from './modules/rubrics/routes/rubricRoutes.js'
import { registerCriterionRoutes } from './modules/rubrics/routes/criterionRoutes.js'
import { registerSubmissionRoutes } from './modules/submissions/routes/submissionRoutes.js'
import { registerTeamRoutes } from './modules/submissions/routes/teamRoutes.js'
import { registerReminderRoutes } from './modules/submissions/routes/reminderRoutes.js'
import { registerCodeHandoutRoutes } from './modules/submissions/routes/codeHandoutRoutes.js'
import { registerFinalRankingRoutes } from './modules/scoring/routes/finalRankingRoutes.js'
import { registerRosterRoutes } from './modules/roster/routes/rosterRoutes.js'
import { registerSlotRoutes } from './modules/roster/routes/slotRoutes.js'
import { registerRegistrationRoutes } from './modules/roster/routes/registrationRoutes.js'
import { installTeamPort } from './modules/submissions/services/teamService.js'
import { installLogisticsPort } from './modules/roster/services/rosterService.js'
import { installMailProvider } from './modules/submissions/services/mailProviders.js'
import { installExtractionPort } from './modules/challenges/services/extractionService.js'
import { installRevalidationJob } from './modules/submissions/jobs/revalidationJob.js'
import { installPreflightPort } from './modules/preflight/services/preflightOrchestrator.js'
import { installPreflightJob } from './modules/preflight/jobs/preflightJob.js'
import { registerPreflightRoutes } from './modules/preflight/routes/preflightRoutes.js'
import { registerScanRoutes } from './modules/scans/routes/scanRoutes.js'
import { registerDiscoveryRoutes } from './modules/discovery/routes/discoveryRoutes.js'
import { registerProbeRoutes } from './modules/probes/routes/probeRoutes.js'
import { registerScoringRoutes } from './modules/scoring/routes/scoringRoutes.js'
import { registerPrinciplesRoutes } from './modules/scoring/routes/principlesRoutes.js'
import { registerReviewRoutes } from './modules/review/routes/reviewRoutes.js'
import { registerCoachRoutes } from './modules/review/routes/coachRoutes.js'
import { registerBatchRoutes } from './modules/batch/routes/batchRoutes.js'
import { registerCalibrationRoutes } from './modules/calibration/routes/calibrationRoutes.js'

export interface BuildOptions {
  /** Disables request logging noise in tests. */
  quiet?: boolean
  /**
   * Skip background jobs. Tests drive scheduled work explicitly through `runTaskNow`, so a
   * timer firing mid-test would make results depend on wall-clock timing.
   */
  withoutJobs?: boolean
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv()
  setLogLevel(options.quiet ? 'error' : env.LOG_LEVEL)

  const app = Fastify({
    // Crucible uses its own structured logger (P9.1); Fastify's is redundant and unredacted.
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  })

  // The governance module provides the audit implementation every other module writes through.
  installAuditPort()
  // The roster reads and creates teams through this rather than importing submissions (ADR 0002).
  installTeamPort()
  installLogisticsPort()
  installMailProvider()
  installExtractionPort()
  // Submissions queue tier-2 checks through this rather than importing preflight (E46).
  installPreflightPort()

  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
    credentials: true,
  })
  await app.register(websocket)
  // Brief artifacts arrive as multipart uploads (E02-S01).
  await app.register(multipart, {
    limits: { files: 1, fileSize: 64 * 1024 * 1024 },
    // Flag truncation rather than throwing, so the route can reject with a message that names
    // the offending file and the configured limit (E02-S01 acceptance 2). The plugin's own
    // error says only "request file too large", which tells an organiser nothing actionable.
    throwFileSizeLimit: false,
  })

  // Recorded before any route is mounted, so the registry sees all of them (P8.1 check).
  registerRouteRecorder(app)
  registerCorrelation(app)
  registerErrorHandler(app)
  // Before auth, because the login ceiling has to count attempts that FAIL to authenticate —
  // which is the whole point of having one on that route.
  registerRateCeilings(app)
  registerAuth(app)

  await registerHealthRoutes(app)
  await registerMetricsRoutes(app)
  await registerAuthRoutes(app)
  await registerAuditRoutes(app)
  await registerRunRoutes(app)
  await registerConfigRoutes(app)
  await registerLlmRoutes(app)
  await registerChallengeRoutes(app)
  await registerRubricRoutes(app)
  await registerCriterionRoutes(app)
  await registerSubmissionRoutes(app)
  await registerTeamRoutes(app)
  await registerReminderRoutes(app)
  await registerCodeHandoutRoutes(app)
  await registerRosterRoutes(app)
  await registerSlotRoutes(app)
  await registerRegistrationRoutes(app)
  await registerScanRoutes(app)
  await registerDiscoveryRoutes(app)
  await registerProbeRoutes(app)
  await registerScoringRoutes(app)
  await registerFinalRankingRoutes(app)
  await registerPrinciplesRoutes(app)
  await registerReviewRoutes(app)
  await registerCoachRoutes(app)
  await registerBatchRoutes(app)
  await registerCalibrationRoutes(app)
  await registerPreflightRoutes(app)
  await registerWebsocket(app)

  if (!options.withoutJobs) {
    installRevalidationJob()
    installPreflightJob()
  }

  return app
}
