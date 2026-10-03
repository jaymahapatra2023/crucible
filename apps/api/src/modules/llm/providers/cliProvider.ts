/**
 * A model reached through a locally installed CLI rather than over HTTP (P12.2).
 *
 * The second path to the same models. It exists because provisioning an API key is a separate
 * piece of procurement from installing a tool, and the calibration gate — the control that must
 * pass before this system ranks anything — should not be blocked behind that. An operator with
 * the CLI signed in can score a golden set on a laptop.
 *
 * The same contract as the HTTP provider, which is the point: the gateway, the retry
 * classification, the citation verification and the call log do not know which was used, so a
 * score produced this way is produced by the same pipeline as one produced any other way. Only
 * `llm_call_log.provider` records the difference, because an auditor is entitled to know.
 *
 * Its limits are real and are not hidden:
 *   * It is a subprocess per call, so it is slower than HTTP and cannot be pooled.
 *   * The CLI meters its own usage; the cost it reports is authoritative and `costUsd` on the
 *     call log is taken from it rather than computed from Crucible's price table.
 */
import { spawn } from 'node:child_process'
import { createLogger } from '../../../lib/logger.js'
import { loadEnv } from '../../../config/env.js'
import {
  ProviderError,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from './providerContract.js'

const log = createLogger('llm', 'cliProvider')

/** What the CLI prints under `--output-format json`. Only these fields are relied upon. */
interface CliResult {
  result?: string
  is_error?: boolean
  stop_reason?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface CliOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Replaced in tests so the suite never spawns a real process. */
let runner: (
  binary: string, args: readonly string[], input: string, timeoutMs: number,
) => Promise<CliOutcome> = spawnCli

export function setCliRunner(next: typeof runner): void { runner = next }
export function resetCliRunner(): void { runner = spawnCli }

function spawnCli(
  binary: string, args: readonly string[], input: string, timeoutMs: number,
): Promise<CliOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })

    child.stdin.on('error', () => { /* closed early; the exit code is what matters */ })
    child.stdin.end(input)
  })
}

export const cliProvider: ModelProvider = {
  name: 'cli',

  /**
   * Declared available whenever a binary is configured.
   *
   * Whether it is installed and signed in is not knowable without running it, and running a
   * model call to answer "are you there" would cost money on every health check. A missing
   * binary surfaces as a named UNAVAILABLE on the first real call instead.
   */
  isAvailable(): boolean {
    return (loadEnv().LLM_CLI_BINARY ?? '') !== ''
  },

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const binary = loadEnv().LLM_CLI_BINARY ?? ''
    if (binary === '') {
      throw new ProviderError('UNAVAILABLE', 'No LLM_CLI_BINARY is configured.')
    }

    const args = [
      '--print',
      '--model', req.model,
      '--output-format', 'json',
      // Replaces the tool's own operating prompt rather than appending to it. Crucible's
      // prompts are versioned and pinned per run (P4.4); inheriting an unrelated system prompt
      // would make a scored result depend on the CLI's version as well as on the rubric.
      '--system-prompt', req.system,
    ]

    let outcome: CliOutcome
    try {
      outcome = await runner(binary, args, req.user, req.timeoutMs)
    } catch (err) {
      throw new ProviderError(
        'UNAVAILABLE',
        `Could not start '${binary}'. Install it, or unset LLM_CLI_BINARY to use the HTTP `
          + `provider.`,
        undefined, err)
    }

    if (outcome.timedOut) {
      throw new ProviderError('TIMEOUT', `'${binary}' did not finish within ${req.timeoutMs} ms.`)
    }
    if (outcome.code !== 0) {
      // Classified as retryable: a non-zero exit here is a transport failure of the same kind a
      // 5xx is, and the gateway already knows how to back off from one (P4.2).
      throw new ProviderError(
        'PROVIDER_ERROR',
        `'${binary}' exited ${outcome.code}: ${firstLine(outcome.stderr) || 'no output'}`)
    }

    return read(outcome.stdout, binary)
  },
}

function read(stdout: string, binary: string): ProviderResponse {
  let parsed: CliResult
  try {
    parsed = JSON.parse(stdout.trim()) as CliResult
  } catch {
    throw new ProviderError(
      'PROVIDER_ERROR',
      `'${binary}' did not print JSON. First line: ${firstLine(stdout) || '(nothing)'}`)
  }

  if (parsed.is_error === true) {
    throw new ProviderError('PROVIDER_ERROR', `'${binary}' reported an error: ${parsed.result ?? ''}`)
  }
  if (typeof parsed.result !== 'string') {
    throw new ProviderError('PROVIDER_ERROR', `'${binary}' returned no result text.`)
  }

  log.debug('cli completion', {
    stopReason: parsed.stop_reason, costUsd: parsed.total_cost_usd,
  })

  return {
    text: parsed.result,
    tokensIn: parsed.usage?.input_tokens ?? 0,
    tokensOut: parsed.usage?.output_tokens ?? 0,
    // Carried through unchanged: `max_tokens` is what the gateway's truncation repair keys on.
    stopReason: parsed.stop_reason ?? 'end_turn',
  }
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.slice(0, 200) ?? ''
