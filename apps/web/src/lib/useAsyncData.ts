import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError } from './apiClient.js'

/**
 * Async data with an explicit three-state result (P5.4, P5.7).
 *
 * `error` is a distinct state rather than `data === null`, so a failed fetch can never be
 * rendered by a caller as an empty result — the distinction P5.7 exists to protect.
 *
 * The loading state is **derived, not assigned**. The obvious implementation sets
 * `{ status: 'loading' }` at the top of the effect, which triggers a second render pass on
 * every dependency change. Instead each result is stored against the key of the request that
 * produced it; whenever the current key has no matching result, the hook is loading by
 * definition. One render per state change, and no stale result can be shown for a new request.
 *
 * **A reload is not a new request.** When the dependencies change, the previous result answers a
 * different question and must not be shown. When the SAME question is asked again, the previous
 * answer is still an answer — possibly out of date, which is what `refreshing` says. Collapsing
 * the two blanked the page on every refresh, which unmounted whatever the caller was rendering:
 * on the roster's assignment surface that destroyed the focused search box and the selected team
 * after every single assignment, two hundred times over.
 */
export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiClientError }
  | { status: 'ready'; data: T }

interface Keyed<T> {
  /** Which question this answers. Unchanged by a reload. */
  depsKey: string
  /** Which request produced it, so a reload in flight is distinguishable from a settled one. */
  fetchKey: string
  state: Exclude<AsyncState<T>, { status: 'loading' }>
}

export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): { state: AsyncState<T>; reload: () => void; refreshing: boolean } {
  const [reloadCount, setReloadCount] = useState(0)
  const [result, setResult] = useState<Keyed<T> | null>(null)

  const depsKey = JSON.stringify(deps)
  const key = `${reloadCount}:${depsKey}`

  // Keep the latest fetcher without making it a dependency: an inline arrow is a new function
  // on every render and would otherwise refetch forever. Synced in an effect rather than during
  // render, because a render must stay free of side effects for React to re-run it safely.
  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  })

  useEffect(() => {
    let cancelled = false
    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled) setResult({ depsKey, fetchKey: key, state: { status: 'ready', data } })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setResult({
          depsKey,
          fetchKey: key,
          state: {
            status: 'error',
            error:
              err instanceof ApiClientError
                ? err
                : new ApiClientError('INTERNAL_ERROR', 'An unexpected error occurred.', 0, err),
          },
        })
      })
    return () => {
      cancelled = true
    }
    // `depsKey` is a substring of `key` by construction, so it cannot change without `key`
    // changing. Listed so the rule does not have to be silenced.
  }, [key, depsKey])

  const reload = useCallback(() => setReloadCount((n) => n + 1), [])

  // A result answering a DIFFERENT question is not shown; one answering this question is, even
  // while a reload of it is in flight.
  const answers = result?.depsKey === depsKey
  const state: AsyncState<T> = answers ? result.state : { status: 'loading' }
  return { state, reload, refreshing: answers && result.fetchKey !== key }
}
