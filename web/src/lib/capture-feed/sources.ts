/**
 * The kinds of source a feed may be of, and what the app needs of each
 * before a session starts: whether this server takes that kind at all, and
 * the title its capture gets. The rest (does the source want a feed now, who
 * owns the capture, who may be in it) is decided in the database, in the
 * same transaction that starts the session (588's capture_feed_start).
 *
 * A producer that joins a Meet, Teams or Zoom call for someone is one more
 * entry here (and in 587's source kinds, and 588's start), not a new route.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callNotesTitle, teamCallRecorderOn } from '@/lib/team-calls/recorder'
import type { CaptureFeedSourceKind } from './contract'

export interface CaptureFeedSource {
  /** This server takes feeds of this kind now. */
  enabled: () => boolean
  /** The capture's title, should the start make it. */
  title: (svc: SupabaseClient, ref: string) => Promise<string>
}

export const CAPTURE_FEED_SOURCES: Record<CaptureFeedSourceKind, CaptureFeedSource> = {
  // One of our own team calls, heard by the call recorder (src/lib/team-calls/recorder.ts).
  team_call: { enabled: () => teamCallRecorderOn(), title: callNotesTitle },
}
