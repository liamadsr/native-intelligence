'use client'

/**
 * Details-on-demand for the knowledge map's inspector.
 *
 * The map itself carries only what the canvas draws, so clicking a node fetches
 * its text / evidence / claims from `GET /api/account/knowledge/map/node`
 * (architecture §2.6, §4.4). Three properties this hook exists to guarantee:
 *
 *  1. The panel NEVER waits on the fetch to appear — the caller renders the
 *     shell from `selectedKey` alone and reads `state` for what goes inside it.
 *  2. Changing selection aborts the in-flight request, so a fast click-through
 *     can never land an older response over a newer node ("last write wins" is
 *     not enough: responses can arrive out of order).
 *  3. `loadMore` appends the next page of an entity's claims, and is itself
 *     abortable by a selection change.
 *
 * Virtual `unfiled:<yyyy-mm>` hubs are never fetched — the route answers 400
 * for them by design — so the hook reports `idle` and the caller renders its
 * small static panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeDetail, NodeKey } from '@/lib/knowledge/graph-map/types'

const NODE_PATH = '/api/account/knowledge/map/node'

export type NodeDetailState =
  /** No selection, or a virtual hub that has no row to fetch. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; detail: NodeDetail; loadingMore: boolean }
  /** The row is gone or invisible — 404. */
  | { status: 'not-found' }
  | { status: 'error' }

export function isVirtualKey(key: NodeKey): boolean {
  return key.startsWith('unfiled:')
}

/** An abort is not a failure — it means a newer selection took over. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

export interface UseMapNodeDetailOptions {
  /** Injected by tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface UseMapNodeDetail {
  state: NodeDetailState
  /** Re-run the fetch for the current key (the error state's Retry). */
  retry: () => void
  /** Entity nodes only: append the next page of claims. No-op otherwise. */
  loadMore: () => void
}

export function useMapNodeDetail(
  selectedKey: NodeKey | null | undefined,
  opts: UseMapNodeDetailOptions = {},
): UseMapNodeDetail {
  const fetchImpl = opts.fetchImpl
  const [state, setState] = useState<NodeDetailState>({ status: 'idle' })
  // Bumping this re-runs the effect for an unchanged key (Retry).
  const [attempt, setAttempt] = useState(0)

  // The controller for whatever request is in flight for the CURRENT key —
  // shared by the initial load and `loadMore` so a selection change cancels
  // either one.
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null

    if (!selectedKey || isVirtualKey(selectedKey)) {
      setState({ status: 'idle' })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setState({ status: 'loading' })

    const doFetch = fetchImpl ?? fetch
    void (async () => {
      try {
        const res = await doFetch(
          `${NODE_PATH}?key=${encodeURIComponent(selectedKey)}`,
          { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } },
        )
        if (controller.signal.aborted) return
        if (res.status === 404 || res.status === 400) {
          setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({ status: 'error' })
          return
        }
        const detail = (await res.json()) as NodeDetail
        if (controller.signal.aborted) return
        setState({ status: 'ready', detail, loadingMore: false })
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return
        setState({ status: 'error' })
      }
    })()

    return () => {
      controller.abort()
    }
  }, [selectedKey, attempt, fetchImpl])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const loadMore = useCallback(() => {
    if (!selectedKey || isVirtualKey(selectedKey)) return
    // Read the cursor off the state at call time rather than closing over it,
    // so `loadMore` keeps a stable identity across pages.
    setState((prev) => {
      if (prev.status !== 'ready' || prev.loadingMore) return prev
      if (prev.detail.kind !== 'entity' || !prev.detail.nextCursor) return prev

      const cursor = prev.detail.nextCursor
      const controller = abortRef.current ?? new AbortController()
      abortRef.current = controller

      const doFetch = fetchImpl ?? fetch
      void (async () => {
        try {
          const res = await doFetch(
            `${NODE_PATH}?key=${encodeURIComponent(selectedKey)}&cursor=${encodeURIComponent(cursor)}`,
            { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } },
          )
          if (controller.signal.aborted) return
          if (!res.ok) {
            // A failed page keeps the claims already on screen; only the
            // "loading more" spinner clears, so the button can be pressed again.
            setState((s) => (s.status === 'ready' ? { ...s, loadingMore: false } : s))
            return
          }
          const page = (await res.json()) as NodeDetail
          if (controller.signal.aborted) return
          setState((s) => {
            // Guard against a page landing after the selection moved on.
            if (s.status !== 'ready' || s.detail.kind !== 'entity') return s
            if (page.kind !== 'entity' || page.key !== s.detail.key) return s
            return {
              status: 'ready',
              loadingMore: false,
              detail: {
                ...s.detail,
                claims: [...s.detail.claims, ...page.claims],
                total: page.total,
                nextCursor: page.nextCursor,
              },
            }
          })
        } catch (err) {
          if (isAbort(err) || controller.signal.aborted) return
          setState((s) => (s.status === 'ready' ? { ...s, loadingMore: false } : s))
        }
      })()

      return { ...prev, loadingMore: true }
    })
  }, [selectedKey, fetchImpl])

  return { state, retry, loadMore }
}
