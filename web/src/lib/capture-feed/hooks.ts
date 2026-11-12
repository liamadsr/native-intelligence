/**
 * Where work on a fed capture's new words attaches: called once per batch
 * of segments the capture took (the segments route, after 588's append
 * answered). Phase 1 does nothing here. Phase 2's server-side live turns
 * (the live agent answering during the call, as a person's own app asks it
 * today with its recent chunks) attach here, behind their own gate, so the
 * route and the feed's contract stay as they are.
 *
 * Never throws into the route: a hook's failure must not make a producer
 * send words the capture already has.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface FeedAppended {
  sessionId: string
  captureId: string
  /** Segments the capture took in this batch (duplicates and drops excluded). */
  accepted: number
  /** The transcript's length after the append. */
  transcriptLength: number | null
}

export type FeedAppendHook = (svc: SupabaseClient, appended: FeedAppended) => Promise<void>

const hooks: FeedAppendHook[] = []

/** Attach a hook (phase 2). Returns its detach. */
export function onFeedAppended(hook: FeedAppendHook): () => void {
  hooks.push(hook)
  return () => {
    const i = hooks.indexOf(hook)
    if (i >= 0) hooks.splice(i, 1)
  }
}

/** Run every hook for a batch the capture took. */
export async function afterFeedAppended(svc: SupabaseClient, appended: FeedAppended): Promise<void> {
  if (appended.accepted <= 0) return
  for (const hook of hooks) {
    try {
      await hook(svc, appended)
    } catch (err) {
      console.warn(`[capture-feed] session=${appended.sessionId} hook failed:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    }
  }
}
