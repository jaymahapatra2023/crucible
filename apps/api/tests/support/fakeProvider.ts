/**
 * Deterministic in-memory model provider for tests.
 *
 * Registered through the same `providerRegistry` the real adapter uses, so gateway tests
 * exercise the production code path end to end — config lookup, prompt rendering, JSON
 * extraction, schema validation, retry, cost accounting and audit logging — with only the
 * network boundary replaced.
 */
import type {
  ModelProvider, ProviderRequest, ProviderResponse,
} from '../../src/modules/llm/providers/providerContract.js'
import { ProviderError } from '../../src/modules/llm/providers/providerContract.js'
import { registerProvider, resetProviders } from '../../src/modules/llm/providers/providerRegistry.js'

export interface ScriptedTurn {
  /** Text the provider returns, or an error it throws instead. */
  text?: string
  throws?: ProviderError
  tokensIn?: number
  tokensOut?: number
  stopReason?: string
}

export class FakeProvider implements ModelProvider {
  readonly name = 'fake'
  /** Every request the gateway made, in order — lets tests assert on prompt content. */
  readonly requests: ProviderRequest[] = []
  private script: ScriptedTurn[] = []
  private responder: ((req: ProviderRequest) => ScriptedTurn | null) | null = null
  private available = true

  /**
   * Answer based on the request rather than on position in a script.
   *
   * A positional script assumes calls arrive one at a time. Under concurrency they do not: a
   * batch scoring four submissions at once interleaves their calls, so submission 1 can receive
   * the response scripted for submission 2's originality pass. That produced a real
   * false failure before this existed, and the misalignment looks like a product defect.
   *
   * Returning null falls through to the positional script, so both styles can be mixed.
   */
  setResponder(fn: (req: ProviderRequest) => ScriptedTurn | null): void {
    this.responder = fn
    this.requests.length = 0
  }

  setScript(turns: ScriptedTurn[]): void {
    this.script = [...turns]
    this.responder = null
    this.requests.length = 0
  }

  setAvailable(value: boolean): void {
    this.available = value
  }

  isAvailable(): boolean {
    return this.available
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req)
    const turn = this.responder?.(req) ?? this.script.shift()
    if (!turn) {
      throw new ProviderError('PROVIDER_ERROR', 'FakeProvider script exhausted — the gateway made more calls than the test scripted.')
    }
    if (turn.throws) throw turn.throws
    return {
      text: turn.text ?? '',
      tokensIn: turn.tokensIn ?? 100,
      tokensOut: turn.tokensOut ?? 50,
      stopReason: turn.stopReason ?? 'end_turn',
    }
  }
}

export function installFakeProvider(): FakeProvider {
  const provider = new FakeProvider()
  resetProviders()
  registerProvider(provider)
  return provider
}

export function restoreProviders(): void {
  resetProviders()
}
