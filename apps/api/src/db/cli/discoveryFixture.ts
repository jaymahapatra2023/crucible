/**
 * A discovered repository, for local development.
 *
 * Fabricated findings, deliberately mixed: some concerns found, one genuinely empty, one that
 * could not be read at all. The whole point of the discovery UI is that those three render
 * differently — a found count, a real zero, and a stated gap — and a fixture where everything
 * succeeded would leave the distinction invisible on every screen that matters.
 */
export type ConcernOutcome = 'FOUND' | 'NONE_FOUND' | 'INSUFFICIENT_EVIDENCE' | 'FAILED'

export interface SeedConcern {
  outcome: ConcernOutcome
  count: number
  note: string
  costUsd: number
  model: string | null
}

export const CONCERNS: Record<string, SeedConcern> = {
  endpoints: { outcome: 'FOUND', count: 3, note: '', costUsd: 0.012, model: 'dev-fixture' },
  entities: { outcome: 'FOUND', count: 2, note: '', costUsd: 0.011, model: 'dev-fixture' },
  capabilities: { outcome: 'FOUND', count: 2, note: '', costUsd: 0.013, model: 'dev-fixture' },
  // A real zero: this application talks to nothing outside itself. Must render as 0.
  integrations: {
    outcome: 'NONE_FOUND', count: 0, costUsd: 0.008, model: 'dev-fixture',
    note: 'None found in the files that were read.',
  },
  security: { outcome: 'FOUND', count: 2, note: '', costUsd: 0.009, model: 'dev-fixture' },
  // A gap, not a zero: the extractor never saw a manifest. Must NOT render as 0.
  stack: {
    outcome: 'INSUFFICIENT_EVIDENCE', count: 0, costUsd: 0, model: null,
    note: 'No manifest or build file was among the files that were read, so the stack could '
      + 'not be identified.',
  },
  claims: { outcome: 'FOUND', count: 1, note: '', costUsd: 0.007, model: 'dev-fixture' },
}

export interface SeedFinding {
  kind: string
  label: string
  summary: string
  detail: Record<string, unknown>
  path: string
  lineStart: number
  lineEnd: number
  excerpt: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

export const FINDINGS: SeedFinding[] = [
  {
    kind: 'ENDPOINT', label: 'POST /api/alerts', summary: 'Raises an alert from a threshold breach',
    detail: {
      method: 'POST', route: '/api/alerts', handler: 'createAlert', auth: 'REQUIRED',
      auth_mechanism: 'requireOperator middleware', parameters: ['deviceId', 'metric'],
      response: 'the created alert',
    },
    path: 'src/routes/alerts.ts', lineStart: 22, lineEnd: 31, confidence: 'HIGH',
    excerpt: "router.post('/api/alerts', requireOperator, createAlert)",
  },
  {
    kind: 'ENDPOINT', label: 'GET /api/alerts', summary: 'Lists open alerts',
    detail: {
      method: 'GET', route: '/api/alerts', handler: 'listAlerts', auth: 'REQUIRED',
      auth_mechanism: 'requireOperator middleware', parameters: ['since', 'limit'],
      response: 'a page of alerts',
    },
    path: 'src/routes/alerts.ts', lineStart: 12, lineEnd: 20, confidence: 'HIGH',
    excerpt: "router.get('/api/alerts', requireOperator, listAlerts)",
  },
  {
    kind: 'ENDPOINT', label: 'GET /healthz', summary: 'Liveness probe',
    // Auth UNKNOWN on purpose: the UI must show UNKNOWN as UNKNOWN. Guessing NONE would
    // invent a security finding; guessing REQUIRED would hide one.
    detail: { method: 'GET', route: '/healthz', handler: 'healthz', auth: 'UNKNOWN', parameters: [] },
    path: 'src/server.ts', lineStart: 44, lineEnd: 45, confidence: 'MEDIUM',
    excerpt: "app.get('/healthz', healthz)",
  },
  {
    kind: 'ENTITY', label: 'reading', summary: 'One telemetry sample from one device',
    detail: {
      store: 'postgres table reading', field_count: 4,
      fields: [
        { name: 'reading_id', type: 'bigserial', key: 'PRIMARY', references: '' },
        { name: 'device_id', type: 'bigint', key: 'FOREIGN', references: 'device' },
        { name: 'metric', type: 'text', key: 'NONE', references: '' },
        { name: 'value', type: 'numeric', key: 'NONE', references: '' },
      ],
      relationships: ['many readings to one device'],
    },
    path: 'db/migrations/002_reading.sql', lineStart: 1, lineEnd: 9, confidence: 'HIGH',
    excerpt: 'CREATE TABLE reading (\n  reading_id BIGSERIAL PRIMARY KEY,',
  },
  {
    kind: 'ENTITY', label: 'alert', summary: 'A breach a person needs to act on',
    detail: {
      store: 'postgres table alert', field_count: 3,
      fields: [
        { name: 'alert_id', type: 'bigserial', key: 'PRIMARY', references: '' },
        { name: 'reading_id', type: 'bigint', key: 'FOREIGN', references: 'reading' },
        { name: 'acknowledged_at', type: 'timestamptz', key: 'NONE', references: '' },
      ],
      relationships: ['one alert to one reading'],
    },
    path: 'db/migrations/003_alert.sql', lineStart: 1, lineEnd: 8, confidence: 'HIGH',
    excerpt: 'CREATE TABLE alert (\n  alert_id BIGSERIAL PRIMARY KEY,',
  },
  {
    kind: 'CAPABILITY', label: 'Threshold detection',
    summary: 'Compares each reading against a per-metric threshold and raises an alert.',
    detail: {
      area: 'PROCESSING', completeness: 'FULL',
      key_files: ['src/detect/threshold.ts', 'src/detect/rules.ts'],
    },
    path: 'src/detect/threshold.ts', lineStart: 14, lineEnd: 48, confidence: 'HIGH',
    excerpt: 'export function detectBreach(reading: Reading, rules: Rule[]): Breach | null {',
  },
  {
    kind: 'CAPABILITY', label: 'Alert acknowledgement',
    summary: 'An operator can acknowledge an alert. The UI control exists; the handler is a stub.',
    // MINIMAL is a factual observation about code, not a criticism — and the UI shows it plainly.
    detail: { area: 'WORKFLOW', completeness: 'MINIMAL', key_files: ['src/routes/alerts.ts'] },
    path: 'src/routes/alerts.ts', lineStart: 52, lineEnd: 55, confidence: 'MEDIUM',
    excerpt: 'export async function acknowledge() {\n  // TODO: persist the acknowledgement\n}',
  },
  {
    kind: 'SECURITY', label: 'INJECTION_RISK',
    summary: 'A query is assembled by interpolating a metric name into a template string.',
    detail: {
      category: 'INJECTION_RISK', concern: 'HIGH',
      observation: 'A query is assembled by interpolating a metric name into a template string.',
      benign_explanation: 'The metric name may be checked against a fixed list before it '
        + 'reaches this line — look at the caller in src/routes/alerts.ts.',
    },
    path: 'src/db/readings.ts', lineStart: 31, lineEnd: 33, confidence: 'HIGH',
    excerpt: 'return db.query(`SELECT * FROM reading WHERE metric = \'${metric}\'`)',
  },
  {
    kind: 'SECURITY', label: 'PERMISSIVE_CORS',
    summary: 'CORS is configured to allow any origin.',
    detail: {
      category: 'PERMISSIVE_CORS', concern: 'MEDIUM',
      observation: 'CORS is configured to allow any origin.',
      benign_explanation: 'This may be a development-only branch — check whether the config '
        + 'is guarded by NODE_ENV.',
    },
    path: 'src/server.ts', lineStart: 18, lineEnd: 19, confidence: 'HIGH',
    excerpt: "app.register(cors, { origin: '*' })",
  },
]

export const CONFLICT = {
  claim: 'Alerts can be acknowledged and are then hidden from the dashboard.',
  claimPath: 'README.md',
  claimLine: 22,
  expected: 'a handler that persists an acknowledgement, and a query that filters on it',
  observed: 'the acknowledgement handler is a stub with a TODO, and no query filters on '
    + 'acknowledged_at — this could still be explained by: the feature may live in code the '
    + 'scan did not read, or behind a flag',
  confidence: 'MEDIUM' as const,
}
