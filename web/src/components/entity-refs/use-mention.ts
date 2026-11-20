'use client'

import { useEffect, useSyncExternalStore } from 'react'
import {
  getMentionState,
  requestMention,
  subscribeMention,
  MENTION_LOADING,
} from './mention-batcher'
import type { MentionState } from './types'

/**
 * Resolve one mention {type, id} through the shared batcher. Requests it on
 * mount (only when `enabled` — a public share never fetches) and subscribes to
 * cache changes. Returns `loading` until it resolves, then `found` / `hidden` /
 * `error`. When disabled it stays `loading` and nothing is fetched, so the chip
 * draws its stored words statically.
 */
export function useMention(type: string, id: string, enabled: boolean): MentionState {
  useEffect(() => {
    if (enabled) requestMention(type, id)
  }, [type, id, enabled])

  return useSyncExternalStore(
    (cb) => subscribeMention(type, id, cb),
    () => (enabled ? getMentionState(type, id) : MENTION_LOADING),
    () => MENTION_LOADING,
  )
}
