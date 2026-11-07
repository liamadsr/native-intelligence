'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  getEntityRefState,
  refreshEntityRef,
  requestEntityRef,
  subscribeEntityRef,
  LOADING_STATE,
} from './entity-ref-batcher'
import { normalizeIdentifier, type EntityRefData, type EntityRefState } from './types'

export interface UseEntityRef {
  data: EntityRefData | null
  status: EntityRefState['status']
  /** Re-resolve this identifier (e.g. after the chip edits the action). */
  refresh: () => Promise<void>
}

/**
 * Resolve one identifier through the shared batcher. Requests it on mount,
 * subscribes to cache changes, and exposes a `refresh` for the chip to call
 * after an edit. Returns `status: 'loading' | 'found' | 'missing'`.
 */
export function useEntityRef(identifier: string): UseEntityRef {
  const id = normalizeIdentifier(identifier)

  useEffect(() => {
    requestEntityRef(id)
  }, [id])

  const state = useSyncExternalStore(
    (cb) => subscribeEntityRef(id, cb),
    () => getEntityRefState(id),
    () => LOADING_STATE,
  )

  const refresh = useCallback(() => refreshEntityRef(id), [id])

  return {
    data: state.status === 'found' ? state.data : null,
    status: state.status,
    refresh,
  }
}
