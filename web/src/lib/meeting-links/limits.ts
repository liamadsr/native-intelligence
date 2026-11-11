/**
 * The public meeting routes' limits (server only).
 *
 * Opening a link and asking to join are counted in the database (574's
 * meeting_rate_hit, per bucket and key within a window), so they hold
 * across every server process: per address (an HMAC of it, src/lib/meeting-links/
 * link.ts rateKeyOf) and per link. A lobby's polling and a guest's token
 * requests carry a signed cookie, checked before anything else, and are
 * counted in this process's memory (per guest and per address): cheap, and
 * a forged cookie never reaches the database at all.
 *
 * A limit that can't be counted (the database refused) lets the request
 * through: an outage of the counter must not shut every meeting.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface MeetingLimit {
  bucket: string
  max: number
  windowSeconds: number
}

/** The limits, by what they count. */
export const MEETING_LIMITS = {
  /** Opening a link (the page, and each public route's lookup), per address. */
  lookupPerAddress: { bucket: 'lookup:addr', max: 60, windowSeconds: 60 },
  /** Opening one link, from anywhere. */
  lookupPerLink: { bucket: 'lookup:link', max: 600, windowSeconds: 60 },
  /** Asking to join, per address. */
  joinPerAddress: { bucket: 'join:addr', max: 10, windowSeconds: 600 },
  /** Asking to join one link, from anywhere. */
  joinPerLink: { bucket: 'join:link', max: 40, windowSeconds: 600 },
  /** A lobby's polls, per guest (every 3 s is 20 a minute) and per address. */
  pollPerGuest: { bucket: 'poll:guest', max: 40, windowSeconds: 60 },
  pollPerAddress: { bucket: 'poll:addr', max: 240, windowSeconds: 60 },
  /** A guest's tokens (a join, a rejoin after a lost connection). */
  tokenPerGuest: { bucket: 'token:guest', max: 20, windowSeconds: 600 },
} as const satisfies Record<string, MeetingLimit>

/** One hit of a limit, counted in the database. True while under it. */
export async function hitLimit(svc: SupabaseClient, limit: MeetingLimit, key: string): Promise<boolean> {
  const { data, error } = await svc.rpc('meeting_rate_hit', { bucket_name: limit.bucket, key, max_hits: limit.max, window_seconds: limit.windowSeconds })
  if (error) {
    console.warn(`[meetings] limit=${limit.bucket} not counted:`, error.message)
    return true
  }
  return data !== false
}

/** Every one of these hits, in the database; true while under all of them (each is counted either way). */
export async function hitLimits(svc: SupabaseClient, hits: ReadonlyArray<[MeetingLimit, string]>): Promise<boolean> {
  const results = await Promise.all(hits.map(([limit, key]) => hitLimit(svc, limit, key)))
  return results.every(Boolean)
}

/** A limit counted in this process's memory, bounded in size (the oldest windows go first). */
export class MemoryLimiter {
  private readonly windows = new Map<string, { start: number; hits: number }>()

  constructor(private readonly maxKeys = 20_000) {}

  hit(limit: MeetingLimit, key: string, now: number = Date.now()): boolean {
    const id = `${limit.bucket}:${key}`
    const span = limit.windowSeconds * 1000
    const cur = this.windows.get(id)
    if (!cur || now - cur.start >= span) {
      this.windows.delete(id)
      this.windows.set(id, { start: now, hits: 1 })
      this.trim(now)
      return 1 <= limit.max
    }
    cur.hits = Math.min(cur.hits + 1, limit.max + 1)
    return cur.hits <= limit.max
  }

  private trim(now: number) {
    if (this.windows.size <= this.maxKeys) return
    // Insertion order is oldest first: drop windows until the map is back under its bound.
    for (const [id, w] of this.windows) {
      if (this.windows.size <= this.maxKeys * 0.9) break
      if (now - w.start >= 0) this.windows.delete(id)
    }
  }

  get size(): number {
    return this.windows.size
  }
}

/** The process's limiter for the lobby and token routes. */
export const meetingMemoryLimiter = new MemoryLimiter()
