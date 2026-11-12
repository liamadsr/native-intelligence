/**
 * Who a voice is and what they said, as the feed carries it. Pure.
 *
 *   - A participant's LiveKit identity is what the app gave their token: a
 *     member's id, or `guest-<id>` for a meeting's guest. That identity is the
 *     speaker's key on the feed (stable across reconnects and rounds of
 *     notes), and says who they are on their first roster event. Any other
 *     identity (another recorder, an egress) is nobody to transcribe.
 *   - A segment's times are milliseconds from the feed session's start, its
 *     key unique to this process, this track and its place on the track.
 */
import type { RosterEvent, Segment } from './app-client.ts'
import type { Heard } from './deepgram.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GUEST_PREFIX = 'guest-'

/** Who an identity is on the feed, or null for nobody to transcribe. */
export function identityOf(identity: string | null | undefined): RosterEvent['identity'] | null {
  if (!identity) return null
  if (UUID.test(identity)) return { memberId: identity.toLowerCase() }
  if (identity.startsWith(GUEST_PREFIX) && UUID.test(identity.slice(GUEST_PREFIX.length))) return { guestId: identity.slice(GUEST_PREFIX.length).toLowerCase() }
  return null
}

/** A wall-clock time as the feed's clock (ms from the session's start), never before it. */
export function feedMs(wallMs: number, sessionStartedAtMs: number): number {
  return Math.max(0, Math.round(wallMs - sessionStartedAtMs))
}

/** The longest a segment's words are on the feed. */
export const MAX_SEGMENT_TEXT = 4000

/** What Deepgram heard on one speaker's track, as a segment; null for no words. */
export function segmentOf(heard: Heard, speaker: string, sessionStartedAtMs: number, key: string): Segment | null {
  const text = heard.text.replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT_TEXT)
  if (!text) return null
  const startMs = feedMs(heard.startWallMs, sessionStartedAtMs)
  return { key, speaker, text, startMs, endMs: Math.max(startMs, feedMs(heard.endWallMs, sessionStartedAtMs)) }
}

/** Keys for one process: `<process>.<track>.<n>`, so a retry repeats a key and nothing else does. */
export class Keys {
  private readonly prefix: string
  private n = 0
  constructor(prefix: string) {
    this.prefix = prefix
  }
  next(scope: string): string {
    this.n++
    return `${this.prefix}.${scope}.${this.n}`.slice(0, 128)
  }
}

/** A roster event for an identity, or null for nobody to transcribe. */
export function rosterEvent(identity: string, kind: 'joined' | 'left', wallMs: number, sessionStartedAtMs: number, key: string): RosterEvent | null {
  const who = identityOf(identity)
  if (!who) return null
  return { key, speaker: identity, kind, atMs: feedMs(wallMs, sessionStartedAtMs), identity: who }
}
