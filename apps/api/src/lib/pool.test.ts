/**
 * Bounded-parallelism pool (E10-S02, E10-S04).
 *
 * An overnight run depends on two properties of this function: that it never exceeds the limit,
 * and that one failing task cannot end the batch. Both are tested by observation rather than by
 * inspection, because both are easy to believe and hard to notice losing.
 */
import { describe, expect, it } from 'vitest'
import { mapWithLimit } from './pool.js'

const defer = () => {
  let resolve!: (v?: unknown) => void
  const promise = new Promise((r) => { resolve = r as () => void })
  return { promise, resolve }
}

describe('bounded parallelism', () => {
  it('NEVER exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0

    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
    })

    expect(peak).toBe(3)
  })

  it('starts the next task as soon as one finishes, not in fixed batches', async () => {
    const gates = [defer(), defer(), defer()]
    const started: number[] = []

    const run = mapWithLimit([0, 1, 2], 2, async (i) => {
      started.push(i)
      await gates[i]!.promise
    })

    await Promise.resolve()
    expect(started).toEqual([0, 1])

    // Releasing one should admit the third immediately — a batching implementation would wait
    // for both of the first two.
    gates[0]!.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual([0, 1, 2])

    gates[1]!.resolve()
    gates[2]!.resolve()
    await run
  })

  it('preserves INPUT order in the results, whatever order they finished', async () => {
    const results = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms / 10))
      return ms
    })
    expect(results.map((r) => r.status === 'fulfilled' && r.value)).toEqual([30, 10, 20])
  })

  it('does NOT let one failure stop the others (E10-S04 acceptance 1)', async () => {
    const results = await mapWithLimit([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('that submission is broken')
      return n * 10
    })

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    expect(results[3]).toEqual({ status: 'fulfilled', value: 40 })
  })

  it('keeps the failure REASON, so the summary can name it', async () => {
    const [result] = await mapWithLimit([1], 1, async () => {
      throw new Error('the repository vanished')
    })
    expect(result?.status).toBe('rejected')
    expect(String((result as { reason: unknown }).reason)).toMatch(/repository vanished/)
  })

  it('handles an empty list without starting a worker', async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([])
  })

  it('treats a limit below one as one rather than deadlocking', async () => {
    const results = await mapWithLimit([1, 2], 0, async (n) => n)
    expect(results).toHaveLength(2)
  })

  it('never starts more workers than there are items', async () => {
    let started = 0
    await mapWithLimit([1, 2], 50, async () => { started++ })
    expect(started).toBe(2)
  })
})
