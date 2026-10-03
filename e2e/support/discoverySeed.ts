/**
 * E2E fixture: a completed discovery, plus one that could not be read.
 *
 * Written straight to the database rather than produced by running the extractors. The journey
 * under test is a reviewer reading a description of a submission, and making it depend on seven
 * live model calls would make a UI test fail for reasons that have nothing to do with the UI.
 *
 * The deliberately incomplete concerns are the point of the fixture: the page's central promise
 * is that a gap reads as a gap and never as a zero, and that can only be asserted if a gap is
 * actually present.
 */
import pg from 'pg'

function pool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test',
  })
}

const CONCERNS = {
  endpoints: { outcome: 'FOUND', count: 2, note: '', costUsd: 0.01, model: 'e2e' },
  entities: { outcome: 'FOUND', count: 1, note: '', costUsd: 0.01, model: 'e2e' },
  capabilities: { outcome: 'FOUND', count: 1, note: '', costUsd: 0.01, model: 'e2e' },
  // An application really can integrate with nothing. This must render as 0.
  integrations: {
    outcome: 'NONE_FOUND', count: 0, costUsd: 0.01, model: 'e2e',
    note: 'None found in the files that were read.',
  },
  security: { outcome: 'FOUND', count: 1, note: '', costUsd: 0.01, model: 'e2e' },
  // This one could not be read. It must NOT render as 0.
  stack: {
    outcome: 'INSUFFICIENT_EVIDENCE', count: 0, costUsd: 0, model: null,
    note: 'No manifest or build file was among the files that were read.',
  },
  claims: { outcome: 'FOUND', count: 1, note: '', costUsd: 0.01, model: 'e2e' },
}

const FINDINGS: Array<[string, string, string, Record<string, unknown>, string, number, number, string, string]> = [
  ['ENDPOINT', 'GET /api/teams', 'Lists the teams in a challenge',
   { method: 'GET', route: '/api/teams', handler: 'listTeams', auth: 'REQUIRED', auth_mechanism: 'requireAuth', parameters: ['challengeId'] },
   'src/routes/teams.ts', 12, 18, "app.get('/api/teams', { preHandler: requireAuth }, listTeams)", 'HIGH'],
  ['ENDPOINT', 'GET /api/health', 'Liveness probe',
   { method: 'GET', route: '/api/health', handler: 'healthCheck', auth: 'UNKNOWN', parameters: [] },
   'src/routes/teams.ts', 20, 21, "app.get('/api/health', healthCheck)", 'MEDIUM'],
  ['ENTITY', 'team', 'A competing team',
   { store: 'postgres table team', field_count: 3,
     fields: [{ name: 'team_id', type: 'bigserial', key: 'PRIMARY', references: '' },
              { name: 'name', type: 'text', key: 'NONE', references: '' },
              { name: 'challenge_id', type: 'bigint', key: 'FOREIGN', references: 'challenge' }],
     relationships: ['many teams to one challenge'] },
   'db/migrations/001_team.sql', 1, 6, 'CREATE TABLE team (', 'HIGH'],
  ['CAPABILITY', 'Team registration', 'Create and list the teams entering a challenge',
   { area: 'WORKFLOW', completeness: 'PARTIAL', key_files: ['src/routes/teams.ts'] },
   'src/routes/teams.ts', 12, 40, 'export function registerTeamRoutes(app) {', 'HIGH'],
  ['SECURITY', 'INJECTION_RISK', 'A SQL query is built by interpolating a parameter into a template string.',
   { category: 'INJECTION_RISK', concern: 'HIGH',
     observation: 'A SQL query is built by interpolating a parameter into a template string.',
     benign_explanation: 'The caller may validate the name against an allow-list before this runs.' },
   'src/db/query.ts', 2, 3, 'return db.query(`SELECT * FROM team WHERE name = ...`)', 'HIGH'],
]

export interface SeededDiscovery {
  discoveryId: number
  submissionId: number
}

export async function seedDiscovery(submissionId: number): Promise<SeededDiscovery> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE discovery_claim_conflict, discovery_run RESTART IDENTITY CASCADE')

    const scan = await db.query<{ scan_id: number }>(
      'SELECT scan_id FROM scan WHERE submission_id = $1 ORDER BY scan_id DESC LIMIT 1',
      [submissionId])

    const run = await db.query<{ discovery_id: number }>(
      `INSERT INTO discovery_run
         (submission_id, scan_id, commit_sha, status, concerns, model, cost_usd,
          started_by, finished_at)
       VALUES ($1, $2, $3, 'COMPLETED', $4::jsonb, 'e2e', 0.06, 'e2e', now())
       RETURNING discovery_id`,
      [submissionId, scan.rows[0]?.scan_id ?? 1, 'a'.repeat(40), JSON.stringify(CONCERNS)])
    const discoveryId = run.rows[0]!.discovery_id

    for (const [kind, label, summary, detail, path, start, end, excerpt, confidence] of FINDINGS) {
      await db.query(
        `INSERT INTO discovery_finding
           (discovery_id, submission_id, kind, label, summary, detail,
            path, line_start, line_end, excerpt, confidence)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
        [discoveryId, submissionId, kind, label, summary, JSON.stringify(detail),
         path, start, end, excerpt, confidence])
    }

    await db.query(
      `INSERT INTO discovery_claim_conflict
         (discovery_id, submission_id, claim, claim_path, claim_line,
          expected, observed, confidence)
       VALUES ($1,$2,$3,'README.md',3,$4,$5,'MEDIUM')`,
      [discoveryId, submissionId,
       'Supports SAML single sign-on for enterprise customers.',
       'a SAML library and an assertion handler',
       'only a requireAuth preHandler was found — this could still be explained by: '
         + 'the SSO code may sit outside what the scan read'])

    return { discoveryId, submissionId }
  } finally {
    await db.end()
  }
}

/** Remove every discovery, so the "not described yet" state can be exercised. */
export async function clearDiscovery(): Promise<void> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE discovery_claim_conflict, discovery_run RESTART IDENTITY CASCADE')
  } finally {
    await db.end()
  }
}
