import { useCallback, useEffect, useState } from 'react'
import type { Page } from './catalogApi'

interface State<T> {
  items: T[]
  cursor: string | null
  /** true while a page is being fetched */
  loading: boolean
  failed: boolean
}

/** Cursor-paged list (SPEC section 12). The fetcher is read once, at mount: to start over with
 * different filters, remount the component that calls this hook by changing its `key`. */
export function usePagedList<T>(fetchPage: (cursor: string | null) => Promise<Page<T>>) {
  const [fetcher] = useState(() => fetchPage)
  const [state, setState] = useState<State<T>>({
    items: [],
    cursor: null,
    loading: true,
    failed: false,
  })

  const load = useCallback(
    (cursor: string | null) => {
      fetcher(cursor).then(
        (page) =>
          setState((s) => ({
            items: cursor === null ? page.items : [...s.items, ...page.items],
            cursor: page.next_cursor,
            loading: false,
            failed: false,
          })),
        () => setState((s) => ({ ...s, loading: false, failed: true })),
      )
    },
    [fetcher],
  )

  useEffect(() => {
    load(null)
  }, [load])

  const loadMore = useCallback(() => {
    if (state.loading || state.cursor === null) return
    setState((s) => ({ ...s, loading: true, failed: false }))
    load(state.cursor)
  }, [load, state.cursor, state.loading])

  const retry = useCallback(() => {
    setState((s) => ({ ...s, loading: true, failed: false }))
    load(state.items.length === 0 ? null : state.cursor)
  }, [load, state.cursor, state.items.length])

  return { ...state, hasMore: state.cursor !== null, loadMore, retry }
}
