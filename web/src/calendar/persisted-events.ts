import type { IEvent } from '@/calendar/interfaces'

// ── The calendar's persisted copy (instant paint on cold load) ─────────────
// The last successful fetch for the DEFAULT filter is mirrored to localStorage
// (use-calendar-events.ts) so a full page load paints the calendar in the same
// frame it mounts, then revalidates in the background. Persisted data is only
// ever a placeholder: hydration never marks the cache fresh, so the mount
// fetch still runs.
//
// localStorage is ONE 5 MB bucket per origin, and it also holds what is not a
// placeholder: every tab's chat thread. These copies used to be kept per
// workspace, up to 4M characters each, and never removed — four workspaces'
// calendars filled the desktop app's bucket, and from then on every chat
// thread write was refused, silently (a tab came back named, its windows
// open, its chat empty). So all the copies together stay inside a budget:
// the workspace being written comes first, then a copy too old to warm-start
// anything goes, then the least recently written, until the rest fit.
//
// A leaf module (no React, no app imports) so the dashboard's boot sweep can
// prune the copies without pulling in the calendar hook, whose imports lead
// back to the tabs.
const PERSIST_PREFIX = 'dial8:calendar-events:v1:'
// Counted at 2 bytes a character, which is what WebKit (the desktop app)
// charges for any string holding a character outside Latin-1 — event titles
// and invite HTML nearly always do.
const PERSIST_BUDGET_BYTES = 2_000_000
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** What a key and its value cost against the storage quota, at most. */
function storedBytes(key: string, value: string): number {
  return (key.length + value.length) * 2
}

/** When a persisted copy was written (0 when unreadable), read off the front
 *  of the payload — writePersistedEvents always starts it with `at` — rather
 *  than parsing a copy only to throw it away. */
function persistedAt(raw: string): number {
  const match = /^\{"at":(\d+)/.exec(raw)
  return match ? Number(match[1]) : 0
}

/** Make room: every copy but `keep` that is too old to warm-start anything
 *  goes, then the least recently written, until what is left fits in `room`
 *  bytes. */
function evictPersistedEvents(keep: string | null, room: number) {
  // Collected, then removed — removing while walking localStorage.key(i)
  // shifts the indices.
  const copies: Array<{ key: string; at: number; bytes: number }> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || key === keep || !key.startsWith(PERSIST_PREFIX)) continue
    const raw = localStorage.getItem(key) ?? ''
    copies.push({ key, at: persistedAt(raw), bytes: storedBytes(key, raw) })
  }
  copies.sort((a, b) => a.at - b.at)
  let total = copies.reduce((sum, c) => sum + c.bytes, 0)
  const now = Date.now()
  for (const c of copies) {
    if (total <= room && now - c.at <= PERSIST_MAX_AGE_MS) continue
    localStorage.removeItem(c.key)
    total -= c.bytes
  }
}

/** Store a workspace's copy, inside the budget. Failures just mean no warm
 *  start — never fatal, never thrown. */
export function writePersistedEvents(workspaceId: string, events: IEvent[]): void {
  if (typeof window === 'undefined') return
  const key = PERSIST_PREFIX + workspaceId
  try {
    const payload = JSON.stringify({ at: Date.now(), events })
    const bytes = storedBytes(key, payload)
    if (bytes > PERSIST_BUDGET_BYTES) {
      // Too big for the budget on its own: no warm start for this workspace,
      // rather than an older copy of a calendar that has moved on.
      localStorage.removeItem(key)
      return
    }
    evictPersistedEvents(key, PERSIST_BUDGET_BYTES - bytes)
    localStorage.setItem(key, payload)
  } catch {
    // Quota/serialization failures just mean no warm start — never fatal.
  }
}

/** A workspace's stored copy, or null when there is none it can still use. */
export function readPersistedEvents(workspaceId: string): IEvent[] | null {
  if (typeof window === 'undefined') return null
  try {
    const key = PERSIST_PREFIX + workspaceId
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: number; events?: IEvent[] }
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > PERSIST_MAX_AGE_MS) {
      // Never usable again — only taking up room.
      localStorage.removeItem(key)
      return null
    }
    if (!Array.isArray(parsed.events)) return null
    return parsed.events
  } catch {
    return null
  }
}

/**
 * Bring the stored copies inside the budget without writing one. Writing is
 * what prunes them otherwise, and only a mounted calendar writes — a long
 * wait when they have already filled the bucket and every chat thread write
 * is refused meanwhile — so the dashboard runs this once after boot.
 */
export function prunePersistedEvents(): void {
  if (typeof window === 'undefined') return
  try {
    evictPersistedEvents(null, PERSIST_BUDGET_BYTES)
  } catch {
    // Storage unavailable: nothing to prune.
  }
}
