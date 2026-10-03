/**
 * Bootstrap environment (E01-S03, P7.5).
 *
 * Environment variables are **bootstrap-only**: how to reach the database, how to sign a token,
 * how to reach a provider. Everything that governs runtime behaviour — model name, concurrency,
 * cost ceiling, depth profile, every threshold — lives in the database (`app_config`) and is
 * read through `configService`, so it survives a restart and can be changed without a redeploy.
 *
 * Validation is fail-fast and names every problem at once: a deployment that is misconfigured
 * stops at boot rather than misbehaving under load (E01-S03 acceptance 1).
 */
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { registerSecrets } from '../lib/redact.js'
import { envFilePath } from '../lib/paths.js'

export const NODE_ENVS = ['development', 'test', 'production'] as const
export type NodeEnv = (typeof NODE_ENVS)[number]

/**
 * An optional variable set to nothing means "not configured", not "invalid".
 *
 * A blank line in a `.env` file, a key left empty in a secret, or a CI variable defined without a
 * value are all ways an operator says "I have not set this yet". Treating them as a validation
 * error refuses to boot over a variable the process does not need; treating them as absent takes
 * the documented path for that variable — the gateway fails model calls with a named error, token
 * reveal stays unavailable, Discord delivery falls back to email.
 */
const blankIsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3101),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Postgres connection string. Required — Crucible has no in-memory mode. */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  /** Signing secret for session tokens (P8.3 — never logged, never defaulted in production). */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),

  /**
   * Provider credential for the LLM gateway. Optional: the gateway starts without it and every
   * model-backed call then fails with a named error rather than the process refusing to boot,
   * so scanning, probing and review remain usable while a key is being provisioned.
   */
  ANTHROPIC_API_KEY: blankIsAbsent(z.string().min(1)),

  /**
   * A locally installed CLI that reaches the same models, used instead of the HTTP provider.
   *
   * The second path to a model, for an operator who has the tool installed and signed in but no
   * API key provisioned. Bootstrap-only, like the credential beside it: WHICH provider a call
   * uses is runtime behaviour and lives in `llm_call_config` (P7.5); whether this machine can
   * reach one at all is a property of the machine.
   *
   * Not a secret — it is a path — so it is deliberately absent from `registerSecrets`.
   */
  LLM_CLI_BINARY: blankIsAbsent(z.string().min(1)),

  /** Absolute path for ephemeral clone and probe workspaces. Defaults to the OS temp dir. */
  WORKSPACE_ROOT: blankIsAbsent(z.string().min(1)),

  /**
   * Which mail adapter this machine uses (E34).
   *
   * `record` composes each message and transmits nothing, leaving the operator to send them.
   * Bootstrap-only, like the model provider beside it: whether this machine can reach a mail
   * service is a property of the machine, not a runtime decision.
   */
  MAIL_PROVIDER: z.string().min(1).default('record'),

  /** The address teams see as the sender. Required only by an adapter that actually transmits. */
  MAIL_FROM: blankIsAbsent(z.string().email()),

  /** Credential for whichever mail service is configured (P8.3 — registered with the redactor). */
  MAIL_API_KEY: blankIsAbsent(z.string().min(1)),

  /**
   * An SMTP relay this machine may send through (MAIL_PROVIDER=smtp).
   *
   * The point of this adapter is that it needs no domain of its own: authenticating as a mailbox
   * authorises sending as that mailbox, so a Gmail account with an app password delivers with
   * Google's reputation rather than a cold domain's. Port 587 with STARTTLS is the default;
   * SMTP_SECURE=true selects implicit TLS on 465.
   */
  SMTP_HOST: blankIsAbsent(z.string().min(1)),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: blankIsAbsent(z.string().min(1)),
  SMTP_PASSWORD: blankIsAbsent(z.string().min(1)),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),

  /**
   * Seals submission tokens so an admin can reveal them (E47-S02, ADR 0005). 32 bytes, base64.
   * Optional: without it tokens are issued and verified as always and reveal reports that it is
   * unavailable. Registered with the redactor.
   */
  /**
   * Discord delivery (E49). Both optional; the guild is required once a token is set, because a
   * bot with no server cannot resolve a username or DM anybody, and boot should say so.
   */
  DISCORD_BOT_TOKEN: blankIsAbsent(z.string().min(20)),
  DISCORD_GUILD_ID: blankIsAbsent(z.string().regex(/^[0-9]{15,22}$/, 'must be a Discord server (guild) id')),

  TOKEN_REVEAL_KEY: blankIsAbsent(z.string().refine(
    (v) => /^[A-Za-z0-9+/=]+$/.test(v) && Buffer.from(v, 'base64').length === 32,
    { message: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)' },
  )),
}).superRefine((env, ctx) => {
  /*
   * A transmitting adapter chosen without its credentials is a misconfiguration, and E01-S03 says a
   * misconfigured deployment stops at boot naming the problem. This is distinct from the DEFAULT —
   * `record` — which needs nothing and composes rather than sends. Choosing `resend` is an explicit
   * act; doing it without a key or a sender is the deployment saying two contradictory things.
   */
  if (env.DISCORD_BOT_TOKEN !== undefined && env.DISCORD_GUILD_ID === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DISCORD_GUILD_ID'],
      message: 'is required when DISCORD_BOT_TOKEN is set — the event server the bot lives in' })
  }
  if (env.MAIL_PROVIDER === 'smtp') {
    for (const [key, what] of [
      ['SMTP_HOST', 'the relay to connect to'],
      ['SMTP_USER', 'the mailbox to authenticate as'],
      ['SMTP_PASSWORD', 'that mailbox\'s password or app password'],
      ['MAIL_FROM', 'the address teams see as the sender'],
    ] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key],
          message: `is required when MAIL_PROVIDER is smtp — ${what}` })
      }
    }
    // Sending as an address the relay has not authorised is the commonest way this fails, and it
    // fails silently at the receiver rather than loudly here. Said at boot instead.
    if (env.MAIL_FROM !== undefined && env.SMTP_USER !== undefined
        && env.SMTP_USER.includes('@') && env.SMTP_USER !== env.MAIL_FROM) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAIL_FROM'],
        message: `is ${env.MAIL_FROM} but SMTP_USER is ${env.SMTP_USER}; a relay normally refuses `
          + 'to send as an address other than the mailbox you authenticated as, or the receiver '
          + 'drops it. Set them to the same address, or use a relay that permits the alias' })
    }
  }
  if (env.MAIL_PROVIDER === 'resend') {
    if (env.MAIL_API_KEY === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAIL_API_KEY'],
        message: 'is required when MAIL_PROVIDER is resend' })
    }
    if (env.MAIL_FROM === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAIL_FROM'],
        message: 'is required when MAIL_PROVIDER is resend — the address teams see as the sender' })
    }
  }
})

export type Env = z.infer<typeof envSchema>

export class ConfigurationError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(
      `Configuration is invalid; the process cannot start. ` +
        `${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`,
    )
    this.name = 'ConfigurationError'
    this.problems = problems
  }
}

let cached: Env | null = null

/**
 * Load the workspace-root `.env` if present.
 *
 * Parsed here rather than via `process.loadEnvFile` so that **a real environment variable always
 * wins over a file value**. That precedence is what lets a test run, a CI job or a container
 * point at a different database by exporting one variable, without the checked-in development
 * `.env` silently overriding it — a failure mode that is very hard to see from a test failure.
 */
function loadDotEnv(): void {
  let text: string
  try {
    text = readFileSync(envFilePath(), 'utf8')
  } catch {
    // No .env file — expected in CI and production, where variables come from the environment.
    return
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (key in process.env) continue // real environment wins
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

/**
 * Validate and return the bootstrap environment. Throws `ConfigurationError` naming every
 * invalid or missing variable. Secrets are registered with the redactor before anything else
 * can log, so a boot-time failure cannot print a credential (E01-S03 acceptance 2).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  loadDotEnv()

  const parsed = envSchema.safeParse(source === process.env ? process.env : source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const name = i.path.join('.') || '(root)'
      // A cross-field rule (E43) carries its own reason — "required when MAIL_PROVIDER is resend"
      // — and that reason is the actionable part. The generic wording below would drop it.
      if (i.code === 'custom') return `${name} ${i.message}`
      const present = source[name] !== undefined
      return present
        ? `${name} is invalid: ${i.message}`
        : `${name} is required but was not set`
    })
    throw new ConfigurationError(problems)
  }

  registerSecrets([
    parsed.data.JWT_SECRET,
    parsed.data.ANTHROPIC_API_KEY,
    // Registered before any adapter can use it, so a provider error quoting the key back is
    // masked wherever it surfaces — message, stack, or nested cause (P8.3).
    parsed.data.MAIL_API_KEY,
    parsed.data.SMTP_PASSWORD,
    parsed.data.TOKEN_REVEAL_KEY,
    parsed.data.DISCORD_BOT_TOKEN,
    passwordFromUrl(parsed.data.DATABASE_URL),
  ])

  cached = parsed.data
  return cached
}

/** Test seam — forces the next `loadEnv` to re-validate. */
export function resetEnvCache(): void {
  cached = null
}

/** Extract the password from a connection string so the redactor can mask it everywhere. */
function passwordFromUrl(url: string): string | undefined {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.password === '' ? undefined : decodeURIComponent(parsedUrl.password)
  } catch {
    return undefined
  }
}

export const isProduction = (e: Env): boolean => e.NODE_ENV === 'production'
export const isTest = (e: Env): boolean => e.NODE_ENV === 'test'
