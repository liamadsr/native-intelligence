/**
 * Where work on a fed capture's new words attaches: called once per batch
 * of segments the capture took (the segments route, after 588's append
 * answered). The live agent's server-side turns on a call's capture attach
 * here (src/lib/team-calls/live-turns.ts, behind TEAM_CALL_LIVE_AGENT), so
 * the route and the feed's contract stay as they are.
 *
 * Never throws into the route: a hook's failure must not make a producer
 * send words the capture already has. A hook returns at once: the producer's
 * next batch waits on the route's answer, so its work runs after it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callLiveTurnsHook } from '@/lib/team-calls/live-turns'

export interface FeedAppended {
  sessionId: string
  captureId: string
  /** Segments the capture took in this batch (duplicates and drops excluded). */
  accepted: number
  /** The transcript's length after the append. */
  transcriptLength: number | null
}

export type FeedAppendHook = (svc: SupabaseClient, appended: FeedAppended) => Promise<void>

const hooks: FeedAppendHook[] = [callLiveTurnsHook]

/** Attach a hook. Returns its detach. */
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
