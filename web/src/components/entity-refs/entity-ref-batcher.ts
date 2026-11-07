/**
 * Module-level batcher + cache for action-identifier resolution.
 *
 * Every chip and every document decoration that wants to know whether an
 * identifier is real calls `requestEntityRef(id)`. Requests made within a short
 * window (BATCH_MS) across the whole page are coalesced into a SINGLE call to
 * GET /api/account/entities/resolve, the results (including "not found") are
 * cached, and subscribers are notified. A chip can force a re-fetch of one
 * identifier after it edits the action with `refreshEntityRef(id)`.
 *
 * The cache is a module singleton so a hundred chips referencing a dozen
 * identifiers cost one network round-trip, not a hundred.
 */

import {
  normalizeIdentifier,
  type EntityRefState,
  type ResolveResponse,
} from './types'

/** Coalescing window. Requests within this many ms share one fetch. */
const BATCH_MS = 30
/** The resolve endpoint caps a single call at 50 refs. */
const MAX_PER_CALL = 50

/** A shared, stable "loading" state. useSyncExternalStore compares snapshots by
 *  identity, so an uncached identifier must always read back the SAME object. */
export const LOADING_STATE: EntityRefState = { status: 'loading' }

const cache = new Map<string, EntityRefState>()
/** Identifiers requested but not yet fetched. */
const pending = new Set<string>()
/** Per-identifier change subscribers (chips). */
const perIdSubscribers = new Map<string, Set<() => void>>()
/** Subscribers to ANY cache change (the TipTap decoration plugin). */
const globalSubscribers = new Set<() => void>()

let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The resolver. Overridable so tests can drive the batcher without a real
 * endpoint. Returns the `refs` map for the requested identifiers.
 */
type Fetcher = (refs: string[]) => Promise<ResolveResponse['refs']>

let fetcher: Fetcher = async (refs) => {
  const res = await fetch(
    `/api/account/entities/resolve?refs=${encodeURIComponent(refs.join(','))}`,
    { headers: { Accept: 'application/json' } },
  )
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`)
  const body = (await res.json()) as ResolveResponse
  return body.refs ?? {}
}

/** Test seam: replace the network resolver. Pass null to restore the default. */
export function __setEntityRefFetcher(next: Fetcher | null): void {
  fetcher = next ?? defaultFetcher
}
const defaultFetcher = fetcher

function notify(identifier: string): void {
  const subs = perIdSubscribers.get(identifier)
  if (subs) for (const cb of subs) cb()
  for (const cb of globalSubscribers) cb()
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
  const batch = Array.from(pending)
  pending.clear()

  // Chunk to the endpoint's per-call cap.
  for (let i = 0; i < batch.length; i += MAX_PER_CALL) {
    const chunk = batch.slice(i, i + MAX_PER_CALL)
    try {
      const refs = await fetcher(chunk)
      for (const id of chunk) {
        const found = refs[id]
        cache.set(
          id,
          found ? { status: 'found', data: found } : { status: 'missing' },
        )
        notify(id)
      }
    } catch {
      // A failed lookup resolves to "missing" so the chip falls back to plain
      // text rather than spinning forever; a later refresh can retry.
      for (const id of chunk) {
        cache.set(id, { status: 'missing' })
        notify(id)
      }
    }
  }
}

/**
 * Ask for an identifier to be resolved. Idempotent: an already-cached or
 * already-pending identifier doesn't re-queue. Safe to call on every render.
 */
export function requestEntityRef(identifier: string): void {
  const id = normalizeIdentifier(identifier)
  if (!id) return
  if (cache.has(id) || pending.has(id)) return
  pending.add(id)
  scheduleFlush()
}

/** Current cache state for an identifier — `loading` until it resolves. The
 *  loading fallback is a shared constant so useSyncExternalStore sees a stable
 *  snapshot for an uncached identifier. */
export function getEntityRefState(identifier: string): EntityRefState {
  return cache.get(normalizeIdentifier(identifier)) ?? LOADING_STATE
}

/** Subscribe to changes for ONE identifier. Returns an unsubscribe fn. */
export function subscribeEntityRef(
  identifier: string,
  cb: () => void,
): () => void {
  const id = normalizeIdentifier(identifier)
  let set = perIdSubscribers.get(id)
  if (!set) {
    set = new Set()
    perIdSubscribers.set(id, set)
  }
  set.add(cb)
  return () => {
    const s = perIdSubscribers.get(id)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) perIdSubscribers.delete(id)
  }
}

/** Subscribe to ANY cache change — used by the document decoration plugin to
 *  re-run its decorations as identifiers resolve. Returns an unsubscribe fn. */
export function subscribeEntityRefs(cb: () => void): () => void {
  globalSubscribers.add(cb)
  return () => {
    globalSubscribers.delete(cb)
  }
}

/**
 * Drop the cached result for one identifier and resolve it again — for a chip
 * to call after it edits the action so the chip reflects the new value. Returns
 * a promise that settles once the re-fetch completes.
 */
export async function refreshEntityRef(identifier: string): Promise<void> {
  const id = normalizeIdentifier(identifier)
  if (!id) return
  cache.delete(id)
  pending.delete(id)
  // Resolve this one immediately rather than waiting on the shared window — an
  // edit just happened and the user is looking at the chip.
  try {
    const refs = await fetcher([id])
    const found = refs[id]
    cache.set(id, found ? { status: 'found', data: found } : { status: 'missing' })
  } catch {
    cache.set(id, { status: 'missing' })
  }
  notify(id)
}

/** Test seam: clear all cache, pending and timers. */
export function __resetEntityRefCache(): void {
  cache.clear()
  pending.clear()
  perIdSubscribers.clear()
  globalSubscribers.clear()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
