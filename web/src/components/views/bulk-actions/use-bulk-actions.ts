'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BULK_MAX_IDS, type ViewEntityType } from '@/lib/views/types'
import type { BulkActionId, BulkActionResponse } from './types'

/** The one toast a selection gets when any of it failed. */
function failureMessage(action: BulkActionId, total: number, result: BulkActionResponse): string {
  const verb = action === 'delete' || action === 'archive' ? action : 'update'
  const what = result.success > 0
    ? `Couldn't ${verb} ${result.failed} of ${total} items`
    : `Couldn't ${verb} ${total === 1 ? 'the item' : `${total} items`}`
  const reason = result.errors?.[0]
  return reason ? `${what}: ${reason}` : what
}

export function useBulkActions(
  entityType: ViewEntityType,
  onComplete?: () => void,
  /**
   * Which workspace a selected id lives in, or `null` for "the active one".
   *
   * Only My Actions and Projects with "Show all workspaces" on can answer
   * anything but null, and only there can ONE selection span workspaces — the
   * checkbox is on every row, so a user can tick two workspaces' actions and
   * hit Complete.
   * `/api/account/bulk` acts in a single workspace per request (it takes a flat
   * `ids` array and resolves them against the request's workspace), so a mixed
   * selection is sent as one request PER workspace and the results merged. An
   * unmixed selection — every selection on every other surface — is still
   * exactly one request, with no header, unchanged.
   */
  workspaceIdOf?: (id: string) => string | null,
) {
  const [executing, setExecuting] = useState(false)
  const [lastResult, setLastResult] = useState<BulkActionResponse | null>(null)

  // Use ref for onComplete to keep execute callback stable
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const workspaceIdOfRef = useRef(workspaceIdOf)
  workspaceIdOfRef.current = workspaceIdOf

  const execute = useCallback(async (
    ids: string[],
    action: BulkActionId,
    value?: unknown,
  ): Promise<BulkActionResponse | null> => {
    if (!ids.length) return null
    setExecuting(true)
    try {
      // Partition by workspace. The `null` bucket is the active workspace and
      // is sent without a header, so the common single-workspace case produces
      // the identical request it always did.
      const byWorkspace = new Map<string | null, string[]>()
      for (const id of ids) {
        const wsId = workspaceIdOfRef.current?.(id) ?? null
        const bucket = byWorkspace.get(wsId)
        if (bucket) bucket.push(id)
        else byWorkspace.set(wsId, [id])
      }

      // `errors` is optional on the response type; kept as a concrete array
      // here so every bucket can append to one list.
      const errors: string[] = []
      const merged: BulkActionResponse = { success: 0, failed: 0, errors }
      let anySucceeded = false

      // The route refuses more than BULK_MAX_IDS ids per request, and a
      // select-all on a grouped view can hold several hundred rows — so each
      // bucket goes out in chunks of that size.
      const requests: Array<{ wsId: string | null; chunk: string[] }> = []
      for (const [wsId, bucketIds] of byWorkspace) {
        for (let i = 0; i < bucketIds.length; i += BULK_MAX_IDS) {
          requests.push({ wsId, chunk: bucketIds.slice(i, i + BULK_MAX_IDS) })
        }
      }

      // Sequential rather than concurrent: these are writes, and a burst of
      // parallel bulk writes is exactly the load pattern the endpoint is worst
      // at. Each request is independent — one workspace or chunk failing must
      // not cost the others their result or the refetch.
      for (const { wsId, chunk } of requests) {
        try {
          const res = await fetch('/api/account/bulk', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // The interceptor only fills this in when the caller hasn't, and
              // the route re-verifies membership — so naming a workspace here
              // says WHICH of the user's workspaces to act in, never widens
              // what they may touch.
              ...(wsId ? { 'x-workspace-id': wsId } : {}),
            },
            body: JSON.stringify({
              entity_type: entityType,
              ids: chunk,
              action,
              value,
            }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Unknown error' }))
            throw new Error(err.error || 'Bulk action failed')
          }
          const result = await res.json() as BulkActionResponse
          merged.success += result.success ?? 0
          merged.failed += result.failed ?? 0
          if (result.errors?.length) errors.push(...result.errors)
          // A 200 that reports only failures (e.g. every row skipped by RLS)
          // changed nothing — don't clear the selection over it.
          if ((result.success ?? 0) > 0 || !(result.failed ?? 0)) anySucceeded = true
        } catch (err) {
          merged.failed += chunk.length
          errors.push((err as Error).message)
        }
      }

      setLastResult(merged)
      // Never fail silently: a refused request or rows the server skipped
      // used to leave the selection sitting there with no word as to why.
      if (merged.failed > 0) toast.error(failureMessage(action, ids.length, merged))
      // Once, after every request has settled — it clears the selection and
      // refetches, and doing that per request would fire N refetches and wipe
      // the selection out from under the requests still in flight. When
      // nothing succeeded the selection stays, so the user can retry.
      if (anySucceeded) onCompleteRef.current?.()
      return merged
    } finally {
      setExecuting(false)
    }
  }, [entityType])

  return { execute, executing, lastResult }
}
