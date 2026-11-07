'use client'

import { useCallback, useEffect, useState, useMemo } from 'react'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import {
  type LabelWithScope,
  type LabelGroup,
  type LabelScope,
  groupLabelsByGroupName,
} from './utils'

interface UseScopedLabelsResult {
  /** Flat list of labels matching the scope */
  labels: LabelWithScope[]
  /** Labels organized by group_name */
  grouped: LabelGroup[]
  /** Whether labels are currently loading */
  loading: boolean
}

// ─── Module-level request coalescing + cache ─────────────────
// Many consumers (one per row × per cell + side panels + filters) ask for the
// same scope simultaneously. Without this, each consumer fires its own
// request and the dev proxy serializes them — single-action page-loads can
// trigger 25+ identical fetches and the picker dropdown appears blank until
// they all resolve. We cache the resolved data and dedupe in-flight requests.
//
// Cache keys include the active workspaceId so labels from Workspace A don't
// render inside Workspace B's pickers after a switch. The server enforces
// workspace via session cookies (so cross-workspace data can't actually be
// fetched), but without keying the cache, a stale in-memory entry from
// Workspace A would be served back to a render that's now in Workspace B.
const labelsCache = new Map<string, LabelWithScope[]>()
const inFlight = new Map<string, Promise<LabelWithScope[]>>()
const subscribers = new Map<string, Set<(labels: LabelWithScope[]) => void>>()

function cacheKey(scope?: LabelScope) {
  const ws = getClientWorkspaceId() ?? 'unknown'
  return `${ws}:${scope ?? '__all__'}`
}

function fetchLabels(scope?: LabelScope): Promise<LabelWithScope[]> {
  const key = cacheKey(scope)
  const cached = labelsCache.get(key)
  if (cached) return Promise.resolve(cached)
  const existing = inFlight.get(key)
  if (existing) return existing

  const url = scope ? `/api/account/labels?scope=${scope}` : '/api/account/labels'
  const promise = fetch(url)
    .then((res) => (res.ok ? res.json() : Promise.reject(res)))
    .then((data) => {
      const next = (data.labels ?? []) as LabelWithScope[]
      labelsCache.set(key, next)
      // Fan out to any other hooks that subscribed while the request was in flight
      subscribers.get(key)?.forEach((cb) => cb(next))
      return next
    })
    .catch(() => {
      // Not cached: a transient failure must not pin "no labels" for the
      // session — the next mount retries. Callers awaiting this request get an
      // empty list; consumers already showing labels keep them.
      return [] as LabelWithScope[]
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}

/** Invalidate cached labels (call after create/edit/delete). Re-fetches and
 * fans out to any currently-mounted consumer so live pickers update immediately
 * instead of waiting for the next mount. */
export function invalidateLabelsCache(scope?: LabelScope) {
  if (scope === undefined) {
    // Keys are `${workspaceId}:${scope ?? '__all__'}`. Re-fetch every scope of
    // the CURRENT workspace that is cached or watched, so its subscribers get
    // fresh data; other workspaces' entries are just dropped (fetchLabels
    // always fetches for the current one).
    const prefix = cacheKey().replace(/__all__$/, '')
    const watched = [...subscribers].filter(([, set]) => set.size > 0).map(([k]) => k)
    const keys = new Set([...labelsCache.keys(), ...watched].filter((k) => k.startsWith(prefix)))
    labelsCache.clear()
    keys.forEach((k) => {
      const s = k.slice(prefix.length)
      fetchLabels(s === '__all__' ? undefined : (s as LabelScope))
    })
  } else {
    const k = cacheKey(scope)
    labelsCache.delete(k)
    // Re-fetch immediately; the subscriber fan-out in fetchLabels notifies
    // every mounted consumer for this scope.
    fetchLabels(scope)
  }
}

/**
 * Fetches workspace labels, optionally filtered by entity scope.
 * Replaces the duplicated fetch-labels pattern across 6+ components.
 *
 * Backed by a module-level cache so concurrent consumers share one request.
 * The cache is workspace-scoped (see `cacheKey`) and the effect re-runs on
 * workspace switch so a picker open during a switch refreshes to the new
 * workspace's labels rather than continuing to show the old set.
 */
export function useScopedLabels(scope?: LabelScope): UseScopedLabelsResult {
  // Read workspaceId via the module-level getter and feed it into the deps
  // array so the effect re-resolves on workspace change. Using the React
  // context hook would be cleaner but would force every label consumer to
  // sit beneath the WorkspaceCacheProvider tree (already true today, but
  // the module-level getter keeps this hook usable from anywhere — and
  // matches the existing pattern in `entity-events.ts`).
  const workspaceId = getClientWorkspaceId()
  const key = cacheKey(scope)
  const [labels, setLabels] = useState<LabelWithScope[]>(() => labelsCache.get(key) ?? [])
  const [loading, setLoading] = useState(() => !labelsCache.has(key))

  useEffect(() => {
    let cancelled = false
    const k = cacheKey(scope)

    // Always register a subscriber so cache invalidation can reach this
    // consumer even when its initial render came from cached data. Without
    // this, creating a new label wouldn't update already-open pickers.
    let set = subscribers.get(k)
    if (!set) {
      set = new Set()
      subscribers.set(k, set)
    }
    const onResolve = (next: LabelWithScope[]) => {
      if (cancelled) return
      setLabels(next)
      setLoading(false)
    }
    set.add(onResolve)

    const cached = labelsCache.get(k)
    if (cached) {
      setLabels(cached)
      setLoading(false)
    } else {
      setLoading(true)
      fetchLabels(scope).then(onResolve)
    }

    return () => {
      cancelled = true
      subscribers.get(k)?.delete(onResolve)
    }
    // workspaceId is intentional — it changes the resolved cacheKey, so the
    // effect must re-run to subscribe to the new workspace's slot.
  }, [scope, workspaceId])

  // Live-sync on label events (a label created/renamed/recolored/deleted by an
  // MCP tool, a teammate, or another tab). invalidateLabelsCache drops the
  // scope's cache and refetches once — the module-level in-flight dedupe means
  // many mounted consumers firing on the same event still make one request, and
  // its subscriber fan-out updates every mounted picker.
  const resync = useCallback(() => {
    invalidateLabelsCache(scope)
  }, [scope])
  useEntityListSync(['label'], resync)

  const grouped = useMemo(() => groupLabelsByGroupName(labels), [labels])

  return { labels, grouped, loading }
}
