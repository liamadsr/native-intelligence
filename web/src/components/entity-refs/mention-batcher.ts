/**
 * Module-level batcher + cache for live MENTION chips — one entry per
 * {type, id} (docs/plans/mentions-everywhere.md, 3.6). It mirrors
 * entity-ref-batcher.ts (which resolves action identifiers): requests made
 * within a short window (BATCH_MS) across the whole page coalesce into a SINGLE
 * GET /api/account/entities/resolve?mentions=…, the answer (found / hidden) is
 * cached, and subscribers are notified. One batcher, one cache: a hundred chips
 * over a dozen records cost one round-trip.
 *
 * The workspace rides in `x-workspace-id`, the way the composer's other calls
 * send it, so the server fences in the right workspace. A found mention carries
 * the caller's own label and status; a mention absent from the answer is one
 * the caller may not read (a locked chip); a failed lookup is NOT a lock (the
 * chip keeps its stored words).
 */

import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import {
  mentionCacheKey,
  type MentionResolveResponse,
  type MentionState,
} from './types'

/** Coalescing window. Requests within this many ms share one fetch. */
const BATCH_MS = 30
/** The resolve endpoint caps a single call at 50 mentions. */
const MAX_PER_CALL = 50

/** A shared, stable "loading" state, so useSyncExternalStore sees one identity. */
export const MENTION_LOADING: MentionState = { status: 'loading' }

const cache = new Map<string, MentionState>()
/** Mentions requested but not yet fetched: key → {type,id}. */
const pending = new Map<string, { type: string; id: string }>()
const perKeySubscribers = new Map<string, Set<() => void>>()

let flushTimer: ReturnType<typeof setTimeout> | null = null

/** The resolver. Overridable so tests can drive the batcher without a network. */
type Fetcher = (
  refs: Array<{ type: string; id: string }>,
) => Promise<MentionResolveResponse['mentions']>

let fetcher: Fetcher = async (refs) => {
  const workspaceId = getClientWorkspaceId()
  const param = refs.map((r) => `${r.type}:${r.id}`).join(',')
  const res = await fetch(`/api/account/entities/resolve?mentions=${encodeURIComponent(param)}`, {
    headers: { Accept: 'application/json', ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
  })
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`)
  const body = (await res.json()) as MentionResolveResponse
  return body.mentions ?? {}
}

/** Test seam: replace the network resolver. Pass null to restore the default. */
export function __setMentionFetcher(next: Fetcher | null): void {
  fetcher = next ?? defaultFetcher
}
const defaultFetcher = fetcher

function notify(key: string): void {
  const subs = perKeySubscribers.get(key)
  if (subs) for (const cb of subs) cb()
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, BATCH_MS)
}

async function flush(): Promise<void> {
  if (pending.size === 0) return
  const batch = [...pending.values()]
  pending.clear()

  for (let i = 0; i < batch.length; i += MAX_PER_CALL) {
    const chunk = batch.slice(i, i + MAX_PER_CALL)
    try {
      const answer = await fetcher(chunk)
      for (const r of chunk) {
        const key = mentionCacheKey(r.type, r.id)
        const found = answer[key] ?? answer[`${r.type}:${r.id}`]
        cache.set(key, found ? { status: 'found', data: found } : { status: 'hidden' })
        notify(key)
      }
    } catch {
      // A failed lookup keeps the chip's stored words (a clickable chip), never
      // a false lock. It is cached so render loops don't re-queue it forever.
      for (const r of chunk) {
        const key = mentionCacheKey(r.type, r.id)
        cache.set(key, { status: 'error' })
        notify(key)
      }
    }
  }
}

/**
 * Ask for a mention to be resolved. Idempotent: an already-cached or already-
 * pending one does not re-queue. Safe to call on every render.
 */
export function requestMention(type: string, id: string): void {
  if (!type || !id) return
  const key = mentionCacheKey(type, id)
  if (cache.has(key) || pending.has(key)) return
  pending.set(key, { type, id: id.trim().toLowerCase() })
  scheduleFlush()
}

/** Current cache state for a mention — `loading` until it resolves. */
export function getMentionState(type: string, id: string): MentionState {
  return cache.get(mentionCacheKey(type, id)) ?? MENTION_LOADING
}

/** Subscribe to changes for ONE mention. Returns an unsubscribe fn. */
export function subscribeMention(type: string, id: string, cb: () => void): () => void {
  const key = mentionCacheKey(type, id)
  let set = perKeySubscribers.get(key)
  if (!set) {
    set = new Set()
    perKeySubscribers.set(key, set)
  }
  set.add(cb)
  return () => {
    const s = perKeySubscribers.get(key)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) perKeySubscribers.delete(key)
  }
}

/** Test seam: clear all cache, pending and timers. */
export function __resetMentionCache(): void {
  cache.clear()
  pending.clear()
  perKeySubscribers.clear()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
