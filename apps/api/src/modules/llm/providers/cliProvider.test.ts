/**
 * Reaching a model through a locally installed CLI (P12.2).
 *
 * The second path to the same models, for an operator who has the tool but no API key. What
 * matters is that it is indistinguishable from the HTTP path to everything above it: the same
 * contract, the same classified failures, the same stop reason the truncation repair keys on.
 *
 * The runner is stubbed throughout. A test suite that spawned a real process would be slow,
 * would need the tool installed, and would spend money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliProvider, resetCliRunner, setCliRunner, type CliOutcome } from './cliProvider.js'
import { ProviderError } from './providerContract.js'
import { resetEnvCache } from '../../../config/env.js'

const REQUEST = {
  model: 'claude-sonnet-5', system: 'You score criteria.', user: 'Score this.',
  maxTokens: 4096, temperature: 0, timeoutMs: 30_000,
}

const outcome = (over: Partial<CliOutcome> = {}): CliOutcome => ({
  code: 0, stdout: '', stderr: '', timedOut: false, ...over,
})

const reply = (over: Record<string, unknown> = {}) => JSON.stringify({
  result: '{"score":3}', is_error: false, stop_reason: 'end_turn',
  usage: { input_tokens: 1200, output_tokens: 80 }, total_cost_usd: 0.02, ...over,
})

beforeEach(() => {
  process.env['LLM_CLI_BINARY'] = 'fake-cli'
  resetEnvCache()
})

afterEach(() => {
  resetCliRunner()
  delete process.env['LLM_CLI_BINARY']
  resetEnvCache()
})

describe('availability', () => {
  it('is available when a binary is configured', () => {
    expect(cliProvider.isAvailable()).toBe(true)
  })

  it('is NOT available when none is', () => {
    // Emptied rather than deleted: see the note on the refusal test below.
    process.env['LLM_CLI_BINARY'] = ''
    resetEnvCache()
    expect(cliProvider.isAvailable()).toBe(false)
  })

  it('does not run the model to answer whether it is available', () => {
    // A health check that costs money on every call is a health check nobody leaves enabled.
    const runner = vi.fn()
    setCliRunner(runner as never)
    cliProvider.isAvailable()
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('a completed call', () => {
  it('returns the text, the token counts and the stop reason', async () => {
    setCliRunner(async () => outcome({ stdout: reply() }))
    const res = await cliProvider.complete(REQUEST)

    expect(res).toEqual({
      text: '{"score":3}', tokensIn: 1200, tokensOut: 80, stopReason: 'end_turn',
    })
  })

  it('carries max_tokens through — the truncation repair keys on it', async () => {
    setCliRunner(async () => outcome({ stdout: reply({ stop_reason: 'max_tokens' }) }))
    expect((await cliProvider.complete(REQUEST)).stopReason).toBe('max_tokens')
  })

  it('passes the prompt on stdin, not as an argument', async () => {
    // A scoring prompt is tens of kilobytes of untrusted source; an argv of that size fails on
    // every platform at a different limit.
    let seen = ''
    setCliRunner(async (_b, _a, input) => { seen = input; return outcome({ stdout: reply() }) })
    await cliProvider.complete(REQUEST)
    expect(seen).toBe('Score this.')
  })

  it('REPLACES the tool\'s own system prompt rather than appending to it', async () => {
    // Crucible's prompts are versioned and pinned per run (P4.4). Inheriting an unrelated
    // operating prompt would make a score depend on the CLI's version as well as the rubric.
    let args: readonly string[] = []
    setCliRunner(async (_b, a) => { args = a; return outcome({ stdout: reply() }) })
    await cliProvider.complete(REQUEST)

    expect(args).toContain('--system-prompt')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You score criteria.')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('asks for the model the call config named', async () => {
    let args: readonly string[] = []
    setCliRunner(async (_b, a) => { args = a; return outcome({ stdout: reply() }) })
    await cliProvider.complete(REQUEST)
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5')
  })

  it('tolerates a reply with no usage rather than failing the call', async () => {
    const res = await withStdout(reply({ usage: undefined }))
    expect(res.tokensIn).toBe(0)
    expect(res.tokensOut).toBe(0)
  })
})

describe('failures, classified the way the gateway expects (P4.2)', () => {
  it('reports a timeout AS a timeout, so it is retried', async () => {
    setCliRunner(async () => outcome({ timedOut: true }))
    const err = await caught()
    expect(err.kind).toBe('TIMEOUT')
    expect(err.retryable).toBe(true)
  })

  it('reports a missing binary as UNAVAILABLE, naming the way out', async () => {
    setCliRunner(async () => { throw new Error('ENOENT') })
    const err = await caught()
    expect(err.kind).toBe('UNAVAILABLE')
    expect(err.message).toMatch(/unset LLM_CLI_BINARY/)
  })

  it('reports a non-zero exit as a provider error, with what it printed', async () => {
    setCliRunner(async () => outcome({ code: 1, stderr: 'not signed in\nrun `login`' }))
    const err = await caught()
    expect(err.kind).toBe('PROVIDER_ERROR')
    expect(err.message).toMatch(/not signed in/)
  })

  it('refuses output that is not JSON, quoting what it got', async () => {
    setCliRunner(async () => outcome({ stdout: 'Welcome to the tool!\n' }))
    const err = await caught()
    expect(err.message).toMatch(/did not print JSON/)
    expect(err.message).toMatch(/Welcome to the tool/)
  })

  it('refuses a reply the tool itself marked as an error', async () => {
    setCliRunner(async () => outcome({
      stdout: reply({ is_error: true, result: 'rate limit reached' }),
    }))
    expect((await caught()).message).toMatch(/rate limit reached/)
  })

  it('refuses a reply with no result text rather than returning an empty score', async () => {
    // Returning '' here would reach schema validation as a malformed response and be retried
    // three times before failing, hiding that the tool answered nothing at all.
    setCliRunner(async () => outcome({ stdout: reply({ result: undefined }) }))
    expect((await caught()).message).toMatch(/no result text/)
  })

  it('refuses to run at all with no binary configured', async () => {
    // Set to nothing rather than deleted: `loadEnv` reads the developer's own `.env` for any key
    // absent from the process environment, so a deleted key would be repopulated from whatever
    // that machine happens to have configured and this assertion would pass or fail by accident.
    // An empty value is how an operator says "not configured", and the schema reads it that way.
    process.env['LLM_CLI_BINARY'] = ''
    resetEnvCache()
    expect((await caught()).kind).toBe('UNAVAILABLE')
  })
})

async function withStdout(stdout: string) {
  setCliRunner(async () => outcome({ stdout }))
  return cliProvider.complete(REQUEST)
}

async function caught(): Promise<ProviderError> {
  try {
    await cliProvider.complete(REQUEST)
  } catch (err) {
    if (err instanceof ProviderError) return err
    throw err
  }
  throw new Error('expected a ProviderError')
}
