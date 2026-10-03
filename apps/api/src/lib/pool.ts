/**
 * Run tasks with bounded parallelism, preserving input order in the results (E10-S02).
 *
 * Distinct from `Semaphore`, which gates callers that arrive independently. This takes a list
 * that is already known and works through it `limit` at a time — the batch case.
 *
 * Two properties the batch depends on:
 *
 *  - **A failing task does not stop the others.** Each result is settled, never thrown, so one
 *    bad submission cannot end an overnight run (E10-S04 acceptance 1). A caller that wants
 *    failure to be fatal inspects the results and decides.
 *  - **Order is preserved.** Results come back in the order the inputs were given, whatever
 *    order they finished in, so a run's report reads in the order the run was planned.
 */
export type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

export async function mapWithLimit<In, Out>(
  items: readonly In[],
  limit: number,
  fn: (item: In, index: number) => Promise<Out>,
): Promise<Array<Settled<Out>>> {
  const bounded = Math.max(1, Math.floor(limit))
  const results = new Array<Settled<Out>>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  // Never more workers than items: starting fifty for a list of three is harmless but makes
  // the concurrency figure in a log line a lie.
  await Promise.all(
    Array.from({ length: Math.min(bounded, items.length) }, () => worker()),
  )

  return results
}
