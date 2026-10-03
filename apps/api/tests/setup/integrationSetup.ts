/**
 * Integration / API test setup (P10.1).
 *
 * Runs against a REAL Postgres database (`crucible_test`), because the behaviours these tests
 * exist to prove are database behaviours: the append-only audit trigger, the forward-only
 * migration runner, the unique index that makes resume idempotent. A mocked database would
 * assert that the mock behaves like the mock.
 *
 * Environment is set here, before any module reads config — and because real environment
 * variables win over the workspace `.env` (see config/env.ts), the developer's local database
 * cannot be touched by a test run.
 */
import { beforeAll, afterAll } from 'vitest'

process.env['NODE_ENV'] = 'test'
/**
 * One database per test PROJECT, not one shared by all of them.
 *
 * `integration` and `api` run as separate processes at the same time. Sharing a database meant
 * their resets collided: first a TRUNCATE deadlock, then — once that was serialised with an
 * advisory lock — two processes restoring the declared rows at once. Widening the lock to cover
 * the restore fixed the race and made every reset in both projects queue behind a slow
 * migration replay, taking the suite from about two minutes to nearly nine and timing hooks out.
 *
 * Separate databases remove the contention rather than sequencing it. Nothing is shared, so
 * there is nothing to serialise.
 */
const BASE_DB = process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test'
process.env['DATABASE_URL'] = `${BASE_DB}${process.env['TEST_DB_SUFFIX'] ?? ''}`
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ?? 'test-only-jwt-secret-at-least-thirty-two-chars'
process.env['LOG_LEVEL'] = 'error'

/*
 * No real model provider, ever.
 *
 * A developer with `ANTHROPIC_API_KEY` or `LLM_CLI_BINARY` in their own `.env` would otherwise
 * have every gateway-backed test reach a real model: billable, and slow enough that the suite
 * hangs rather than fails — a CLI call takes minutes and there are hundreds of calls. It cost a
 * debugging cycle here once, with twenty `claude` processes alive and the run stalled at 0% CPU.
 *
 * Emptied rather than deleted, because `loadEnv` reads the developer's `.env` for any key absent
 * from the process environment; an empty value is how an operator says "not configured", and the
 * schema reads it that way. Tests that need a model register a fake (`installFakeProvider`).
 */
process.env['ANTHROPIC_API_KEY'] = ''
process.env['LLM_CLI_BINARY'] = ''

/*
 * No real mail provider either, and for a sharper reason than the model one.
 *
 * A developer with MAIL_PROVIDER=smtp in their own `.env` had the suite boot the SMTP adapter and
 * transmit for real: a test asserting a message was PREPARED instead found it SENT, because it
 * had just been delivered to a live mailbox. Tests must not send mail to anybody.
 *
 * `record` composes every message and transmits nothing, which is what the assertions are written
 * against. A test that needs a transmitting adapter registers its own fake.
 */
process.env['MAIL_PROVIDER'] = 'record'
process.env['MAIL_API_KEY'] = ''
process.env['SMTP_HOST'] = ''
process.env['SMTP_USER'] = ''
process.env['SMTP_PASSWORD'] = ''

/*
 * And no real Discord, for the third time in the same shape.
 *
 * An operator who has configured the event bot has a live token in their `.env`, and
 * `discordConfigured()` is read at request time rather than at boot — so a suite that inherited
 * it would resolve usernames against the real event server and DM real people. One already
 * tripped on this: a test asserting the registration form does NOT offer a Discord field found
 * that it did, because the machine running the suite had just been given a bot.
 *
 * Both are emptied, because the schema refuses a token with no guild id and a suite must not
 * fail to boot over a credential it is not allowed to use. Tests that exercise Discord stub
 * `fetch` and set both with `vi.stubEnv`, which is scoped to the test.
 */
process.env['DISCORD_BOT_TOKEN'] = ''
process.env['DISCORD_GUILD_ID'] = ''

const { setLogLevel, setLogSink } = await import('../../src/lib/logger.js')
setLogLevel('error')

/**
 * Discard log output during tests.
 *
 * Many of these tests deliberately exercise failure paths — a rolled-back migration, a refused
 * append-only UPDATE, an exhausted retry ladder — and each correctly logs at error level with a
 * full stack. Printing them buries the actual test results. Failures surface through assertions;
 * captured lines are asserted directly by the logger's own unit tests.
 */
setLogSink(() => undefined)

const { migrate } = await import('../../src/db/migrationRunner.js')
const { migrationsDir } = await import('../../src/lib/paths.js')
const { closePool, query } = await import('../../src/db/pool.js')
// The rate ceilings live in process memory, so the database reset has to clear them too.
const { resetRateLimit } = await import('../../src/http/rateLimit.js')

beforeAll(async () => {
  await ensureProjectDatabase()
  const url = process.env['DATABASE_URL'] ?? ''
  if (!/crucible_test/.test(url)) {
    throw new Error(
      `Refusing to run tests against '${url}'. Tests require a database whose name contains ` +
        `"crucible_test" so a misconfigured run cannot destroy development data.`,
    )
  }
  // Rebuild from scratch rather than migrating onto whatever the last run left behind.
  // `migrate` is a no-op on an already-migrated database, so it cannot restore declared config,
  // flags, call keys or prompts that a previous run truncated — and snapshotting that state
  // would then capture nothing and quietly break every test that depends on it.
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await migrate(migrationsDir())
  await snapshotDeclaredState()
}, 120_000)

/**
 * Create this project's database if it does not exist.
 *
 * Connects to the base database to issue the CREATE, because a connection cannot create the
 * database it is connected to. Ignores "already exists" — two projects may start together.
 */
async function ensureProjectDatabase(): Promise<void> {
  const suffix = process.env['TEST_DB_SUFFIX'] ?? ''
  if (suffix === '') return

  const name = new URL(process.env['DATABASE_URL'] ?? '').pathname.replace(/^\//, '')
  const pg = (await import('pg')).default
  const admin = new pg.Client({ connectionString: BASE_DB })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } catch (err) {
    // 42P04 is duplicate_database, which is the expected outcome on every run but the first.
    if ((err as { code?: string }).code !== '42P04') throw err
  } finally {
    await admin.end()
  }
}

afterAll(async () => {
  await closePool()
})

/**
 * Reset the database to a known state between tests.
 *
 * `audit_event` cannot be DELETEd — the P7.1 trigger refuses it, correctly — so it is truncated,
 * which bypasses row triggers. That is a test-harness privilege, not an application capability:
 * nothing in `src/` can reach it.
 *
 * Configuration and flags are restored by re-running the defaults migration rather than by
 * restating expected values here. Two copies of "what the default is" drift, and a test that
 * inherits a flag another test toggled fails somewhere far from the cause — which is exactly
 * what happened before this was fixed.
 *
 * No cross-process locking: each project owns its own database (see the top of this file), so
 * two resets can never touch the same tables.
 *
 * Within a process there is still one contender: the Fastify app under test shares this pool,
 * and a request whose tail work has not settled can hold a row lock while the TRUNCATE is taking
 * ACCESS EXCLUSIVE on sixty tables. That deadlocks perhaps one run in thirty, always in whichever
 * test happens to reset next rather than in the one that left the work behind.
 *
 * The retry below is a CONCESSION, not a fix. The real answer is for no test to leave work in
 * flight, which cannot be asserted from here — so it is bounded at two attempts and re-throws
 * anything that is not a deadlock, rather than quietly swallowing a genuine failure.
 */
const DEADLOCK = '40P01'

export async function resetDatabase(): Promise<void> {
  /*
   * The HTTP rate ceilings live in process memory, not in the database, so truncating tables does
   * not clear them (E41). Left alone, one suite's sign-ins exhaust the next suite's budget and the
   * failures land in whichever file happened to run later — which is exactly what happened the
   * first time the ceilings were installed: 169 tests failed in eleven files, none of them the one
   * with the bug.
   */
  resetRateLimit()

  const sql = `TRUNCATE TABLE ${await truncatableTables()} RESTART IDENTITY CASCADE`
  try {
    await query(sql)
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string })
    if ((code.cause?.code ?? code.code) !== DEADLOCK) throw err
    // The other side has by now rolled back, so a single retry settles it.
    await query(sql)
  }
  await restoreDeclaredState()
}

let cachedTables: string | null = null

/**
 * Every application table, derived from the schema rather than listed by hand.
 *
 * A hand-maintained list silently stops truncating tables added later, and the resulting
 * failures appear in whichever test happens to run second — far from the cause.
 *
 * `schema_migrations` is excluded: truncating it would make the runner re-apply everything.
 */
async function truncatableTables(): Promise<string> {
  if (cachedTables) return cachedTables
  const res = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename`,
  )
  cachedTables = res.rows.map((r) => `"${r.tablename}"`).join(', ')
  return cachedTables
}

/** Table name → the rows the migrations put in it, in insertion order. */
type DeclaredState = Array<{ table: string; rows: Array<Record<string, unknown>> }>

let declared: DeclaredState | null = null

/**
 * Capture everything the migrations declare, once, straight after migrating.
 *
 * EVERY table that the migrations left rows in is snapshotted — not a hand-written list of five.
 * A list has to be edited whenever a migration seeds something new, and when it is not, the
 * table comes back empty after the first `resetDatabase()` and the failure lands in whichever
 * test happens to need it. That is exactly how the architectural principles seeded by migration
 * 024 disappeared: the rows existed after `migrate`, and nothing restored them.
 *
 * A table with rows straight after migrating is by definition declared state — nothing else has
 * run yet — so "has rows now" is the correct and self-maintaining rule.
 */
async function snapshotDeclaredState(): Promise<void> {
  const tables = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename`,
  )

  const withRows: DeclaredState = []
  for (const { tablename } of tables.rows) {
    const rows = (await query<Record<string, unknown>>(
      `SELECT * FROM "${tablename}"`)).rows
    if (rows.length > 0) withRows.push({ table: tablename, rows })
  }

  // Parents before children. Alphabetical order is not safe: `llm_call_config` references
  // `llm_call_registry` and sorts before it, so restoring by name fails the foreign key.
  const order = await dependencyOrder(withRows.map((t) => t.table))
  declared = [...withRows].sort((a, b) => order.indexOf(a.table) - order.indexOf(b.table))
}

/**
 * Topological order of the given tables, from the schema's own foreign keys.
 *
 * Derived rather than declared, for the same reason the table list is: a hand-maintained order
 * silently stops being correct the moment a migration adds a reference, and the resulting
 * failure is a foreign-key violation in an unrelated test.
 *
 * A cycle (or a self-reference, which `supersede` columns create) cannot be ordered; those
 * tables are appended and their rows inserted with `ON CONFLICT DO NOTHING`, which is enough
 * because declared state is seed data, not a graph of live records.
 */
async function dependencyOrder(tables: readonly string[]): Promise<string[]> {
  const edges = await query<{ child: string; parent: string }>(
    `SELECT DISTINCT
            child.relname  AS child,
            parent.relname AS parent
       FROM pg_constraint c
       JOIN pg_class child  ON child.oid  = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE c.contype = 'f'`,
  )

  const inScope = new Set(tables)
  const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]))
  for (const { child, parent } of edges.rows) {
    if (child === parent) continue
    if (inScope.has(child) && inScope.has(parent)) parentsOf.get(child)!.add(parent)
  }

  const ordered: string[] = []
  const placed = new Set<string>()
  let progress = true

  while (progress) {
    progress = false
    for (const table of tables) {
      if (placed.has(table)) continue
      if ([...parentsOf.get(table)!].every((parent) => placed.has(parent))) {
        ordered.push(table)
        placed.add(table)
        progress = true
      }
    }
  }

  return [...ordered, ...tables.filter((t) => !placed.has(t))]
}

async function restoreDeclaredState(): Promise<void> {
  if (!declared) {
    throw new Error(
      'Declared state was never snapshotted. resetDatabase() was called before the suite ' +
        'setup ran, which would silently leave every config key and prompt missing.',
    )
  }
  // Restored in table order; `ON CONFLICT DO NOTHING` plus deferred-free inserts are enough
  // because declared state has no forward references between tables.
  for (const { table, rows } of declared) await insertRows(table, rows)
}

const columnTypes = new Map<string, Map<string, string>>()

/** Real column types, so a jsonb value is cast as jsonb rather than inferred from its JS shape. */
async function typesFor(table: string): Promise<Map<string, string>> {
  const cached = columnTypes.get(table)
  if (cached) return cached
  const res = await query<{ column_name: string; data_type: string; udt_name: string }>(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )
  const map = new Map(res.rows.map((r) => [
    r.column_name,
    r.data_type === 'ARRAY' ? `${r.udt_name.replace(/^_/, '')}[]` : r.data_type,
  ]))
  columnTypes.set(table, map)
  return map
}

async function insertRows(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return
  const types = await typesFor(table)
  const columns0 = Object.keys(rows[0] as Record<string, unknown>)

  for (const row of rows) {
    const columns = Object.keys(row)
    const placeholders: string[] = []
    const bound: unknown[] = []

    columns.forEach((column, i) => {
      const type = types.get(column) ?? ''
      const value = row[column]
      if (type === 'jsonb' || type === 'json') {
        placeholders.push(`$${i + 1}::${type}`)
        bound.push(JSON.stringify(value))
      } else if (type.endsWith('[]')) {
        placeholders.push(`$${i + 1}::${type}`)
        bound.push(value)
      } else {
        placeholders.push(`$${i + 1}`)
        bound.push(value)
      }
    })

    await query(
      `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`,
      bound,
    )
  }

  await resyncSequences(table, columns0)
}

/**
 * Advance any serial sequence past the ids just restored.
 *
 * `TRUNCATE ... RESTART IDENTITY` resets sequences to 1, and restoring rows with their original
 * ids does not move them. The next insert then reuses id 1 and fails with a primary-key
 * violation — which surfaces as "That record already exists" in a test that has nothing to do
 * with the table in question.
 */
async function resyncSequences(table: string, columns: string[]): Promise<void> {
  for (const column of columns) {
    const seq = await query<{ seq: string | null }>(
      'SELECT pg_get_serial_sequence($1, $2) AS seq', [table, column])
    const name = seq.rows[0]?.seq
    if (!name) continue
    await query(
      `SELECT setval($1, COALESCE((SELECT MAX("${column}") FROM ${table}), 0) + 1, false)`,
      [name])
  }
}
