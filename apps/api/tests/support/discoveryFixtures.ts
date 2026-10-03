/**
 * Source and scripted responses for discovery tests.
 *
 * A repository with enough real shape that the context builder's ranking has something to rank:
 * routes, a migration, a client, a manifest and a README that overclaims. Without that, every
 * concern would come back INSUFFICIENT_EVIDENCE for the boring reason that nothing matched.
 */
import { scannedFile } from './scoringFixtures.js'

export const DISCOVERY_SOURCE = [
  scannedFile('src/routes/teams.ts', [
    "import { requireAuth } from '../auth.js'",
    '',
    'export function registerTeamRoutes(app) {',
    "  app.get('/api/teams', { preHandler: requireAuth }, listTeams)",
    "  app.post('/api/teams', { preHandler: requireAuth }, createTeam)",
    "  app.get('/api/health', healthCheck)",
    '}',
  ].join('\n')),

  scannedFile('db/migrations/001_team.sql', [
    'CREATE TABLE team (',
    '  team_id BIGSERIAL PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  challenge_id BIGINT REFERENCES challenge (challenge_id)',
    ');',
  ].join('\n'), 'sql'),

  scannedFile('src/integrations/storage.ts', [
    "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'",
    '',
    'const client = new S3Client({ region: process.env.AWS_REGION })',
    'export async function upload(key, body) {',
    '  return client.send(new PutObjectCommand({ Bucket: process.env.BUCKET, Key: key, Body: body }))',
    '}',
  ].join('\n')),

  scannedFile('src/db/query.ts', [
    'export function findTeam(name) {',
    '  return db.query(`SELECT * FROM team WHERE name = \'${name}\'`)',
    '}',
  ].join('\n')),

  scannedFile('package.json', [
    '{',
    '  "name": "team-tracker",',
    '  "dependencies": {',
    '    "fastify": "^5.2.0",',
    '    "pg": "^8.13.0"',
    '  },',
    '  "scripts": { "start": "node dist/server.js" }',
    '}',
  ].join('\n'), 'json'),

  scannedFile('README.md', [
    '# Team Tracker',
    '',
    'Supports SAML single sign-on for enterprise customers.',
    'Built with Fastify and Postgres.',
  ].join('\n'), 'markdown'),
]

/**
 * A citation into the fixture repository that is actually TRUE.
 *
 * The excerpt is looked up from `DISCOVERY_SOURCE` rather than written by hand, because a
 * hand-written one drifts from the source the moment either changes — and since E13 a finding
 * whose citation the scan contradicts is dropped, so a drifted fixture fails as a product
 * defect rather than as the fixture error it is.
 */
function located(path: string, line: number) {
  const file = DISCOVERY_SOURCE.find((f) => f.path === path)
  if (!file) throw new Error(`discoveryFixtures: no such file '${path}'`)
  const lines = file.content.split('\n')
  const excerpt = lines[line - 1]
  if (excerpt === undefined) {
    throw new Error(`discoveryFixtures: '${path}' has no line ${line}`)
  }
  return {
    path, line_start: line, line_end: line, excerpt: excerpt.trim(), confidence: 'HIGH',
  }
}

/** A scripted turn per concern, keyed by the call key the gateway is resolving. */
export const DISCOVERY_TURNS: Record<string, unknown> = {
  'discovery.endpoints': {
    endpoints: [
      { ...located('src/routes/teams.ts', 4), method: 'GET', route: '/api/teams', auth: 'REQUIRED', auth_mechanism: 'requireAuth preHandler' },
      { ...located('src/routes/teams.ts', 6), method: 'GET', route: '/api/health', auth: 'NONE' },
    ],
  },
  'discovery.entities': {
    entities: [{
      ...located('db/migrations/001_team.sql', 1),
      name: 'team', store: 'postgres table team', summary: 'A competing team.',
      fields: [
        { name: 'team_id', type: 'bigserial', key: 'PRIMARY' },
        { name: 'challenge_id', type: 'bigint', key: 'FOREIGN', references: 'challenge' },
      ],
      relationships: ['many teams to one challenge'],
    }],
  },
  'discovery.capabilities': {
    capabilities: [{
      ...located('src/routes/teams.ts', 3), name: 'Team registration',
      description: 'Create and list teams.', area: 'WORKFLOW', completeness: 'PARTIAL',
    }],
  },
  'discovery.integrations': {
    integrations: [{
      ...located('src/integrations/storage.ts', 3), target: 'AWS S3',
      protocol: 'SDK', direction: 'OUTBOUND', purpose: 'Stores uploaded artefacts.',
    }],
  },
  'discovery.security': {
    observations: [{
      ...located('src/db/query.ts', 2), category: 'INJECTION_RISK', concern: 'HIGH',
      observation: 'A SQL query is built by interpolating a parameter into a template string.',
      benign_explanation: 'The caller may validate the name against an allow-list first.',
    }],
  },
  'discovery.stack': {
    stack: [
      { ...located('package.json', 4), name: 'Fastify', version: '^5.2.0', category: 'FRAMEWORK', role: 'HTTP server' },
      { ...located('package.json', 5), name: 'pg', version: '^8.13.0', category: 'DATASTORE', role: 'Postgres driver' },
    ],
    runtime: { containerised: false, entrypoint: 'node dist/server.js', notes: 'from the start script' },
  },
  'discovery.claims': {
    conflicts: [{
      claim: 'Supports SAML single sign-on for enterprise customers.',
      claim_path: 'README.md', claim_line: 3,
      expected: 'a SAML library and an assertion handler',
      observed: 'only a requireAuth preHandler was found',
      what_would_explain_it: 'the SSO code may sit outside what the scan read',
      confidence: 'MEDIUM',
    }],
  },
}

/** Answers by call key, so concurrency or ordering changes cannot misalign the script. */
export function discoveryResponder(overrides: Record<string, unknown> = {}) {
  return (req: { system: string; user: string }) => {
    const key = detectKey(req)
    if (key === null) return null
    if (key in overrides) {
      const value = overrides[key]
      return value === null ? null : { text: JSON.stringify(value) }
    }
    return { text: JSON.stringify(DISCOVERY_TURNS[key] ?? {}) }
  }
}

/**
 * Which concern a request belongs to.
 *
 * Read from the prompt rather than from a call key, because the provider contract carries the
 * rendered prompts and not the key. Each discovery user prompt names its own output field.
 */
function detectKey(req: { system: string; user: string }): string | null {
  const text = `${req.system}\n${req.user}`
  if (text.includes('"endpoints"')) return 'discovery.endpoints'
  if (text.includes('"entities"')) return 'discovery.entities'
  if (text.includes('"capabilities"')) return 'discovery.capabilities'
  if (text.includes('"integrations"')) return 'discovery.integrations'
  if (text.includes('"observations"')) return 'discovery.security'
  if (text.includes('"stack"')) return 'discovery.stack'
  if (text.includes('"conflicts"')) return 'discovery.claims'
  return null
}
