'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { actionToIEvent, calendarEventToIEvent } from '@/calendar/adapters'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { mergeWithLocalExchangeEvents } from '@/lib/integrations/calendar-local'
import type { IEvent, IEventCapture } from '@/calendar/interfaces'
import { readPersistedEvents, writePersistedEvents } from '@/calendar/persisted-events'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { useEntityListSync } from '@/hooks/use-entity-sync'

/**
 * Shared account filter (null = "All accounts"). Lives in module scope so the
 * calendar page and the Capture button's calendar agree on which connected accounts are
 * shown — one selection, one cache key. Backed by useSyncExternalStore so every
 * consumer re-renders on change.
 */
let filterAccountIds: string[] | null = null
const filterListeners = new Set<() => void>()
function subscribeFilter(cb: () => void) {
  filterListeners.add(cb)
  return () => filterListeners.delete(cb)
}
function getFilterSnapshot() {
  return filterAccountIds
}
function setFilterAccountIdsShared(ids: string[] | null) {
  filterAccountIds = ids
  filterListeners.forEach((cb) => cb())
}

/**
 * Shared calendar-events fetch.
 *
 * Extracted from CalendarView so both the full calendar page AND the Capture
 * button's calendar consume ONE fetch and ONE module-level cache — no redundant
 * network round-trip when both are mounted, and instant paint on tab switch.
 *
 * Window: 1 month before → 2 months after now (same as the calendar page).
 * Merges: OAuth/provider events + local Exchange (desktop) + timed actions,
 * then hydrates linked captures in the background.
 *
 * `error` is 'no-provider' when no calendar is connected (HTTP 400), so callers
 * can render the "connect a calendar" empty state.
 */

// Module-level cache, shared across every consumer of this hook.
let cachedEvents: IEvent[] | null = null
let cachedFilterKey: string | null = null
let cachedWorkspaceId: string | null = null
// Fingerprint of the last provider baseline (pre-capture-merge). A poll whose
// baseline fingerprints identically keeps the existing array/object identities,
// so nothing downstream re-renders. Cleared whenever the cache is patched
// out-of-band.
//
// {length, hash} rather than the full JSON string: the string is ~hundreds of
// KB for an active calendar and used only for a byte-identity `===` against the
// NEXT 60s poll's baseline, so retaining it pinned that much heap for the whole
// session (a measured contributor to the 948 MB desktop WebContent heap after
// 7h). A hash collision would only cost one unnecessary re-render — the actual
// data returned to consumers never goes through this fingerprint.
let cachedBaseFingerprint: { length: number; hash: number } | null = null

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Baseline for the identity-stable-poll comparison, with volatile fields that
 * no component ever renders stripped out.
 *
 * `attendeeDetails[].responseStatus` churns constantly (every invitee RSVP
 * flips it) but is never RENDERED: it is read only into capture-creation POST
 * bodies (use-start-meeting.ts, calendar-event-detail-panel.tsx) and by
 * lib/crm/calendar-contacts.ts, which runs SERVER-side inside
 * /api/calendar/events before the client sees the payload. Including it here
 * forced a full grid re-render on every poll purely because someone RSVP'd,
 * defeating the identity-stable-poll optimization. The field stays in `IEvent`
 * and in the objects handed to consumers — only this comparison drops it.
 *
 * If a field is ever ADDED to CalendarEventAttendee, re-check whether anything
 * renders it before assuming this strip is still safe.
 */
function fingerprintBaseline(events: IEvent[]): { length: number; hash: number } {
  const stripped = events.map((e) => {
    if (!e.attendeeDetails?.length) return e
    return {
      ...e,
      attendeeDetails: e.attendeeDetails.map(({ responseStatus: _rs, ...rest }) => rest),
    }
  })
  const json = JSON.stringify(stripped)
  return { length: json.length, hash: fnv1a(json) }
}

// Consumers' setEvents callbacks. A successful fetch or an out-of-band cache
// patch (optimistic create/edit/delete) notifies every mounted consumer, so the
// calendar page and the Capture button's calendar stay in lockstep instead of each
// waiting for its own next fetch.
const eventListeners = new Set<(events: IEvent[]) => void>()
function notifyEvents(events: IEvent[]) {
  eventListeners.forEach((cb) => cb(events))
}

// ── Persisted copy (instant paint on cold load) ────────────────────────────
// The default filter's events are mirrored to localStorage inside a budget
// shared by every workspace's copy — see persisted-events.ts.
function persistCache() {
  // Only the default "All accounts" view is persisted — one entry per workspace.
  if (!cachedEvents || !cachedWorkspaceId || cachedFilterKey !== '') return
  writePersistedEvents(cachedWorkspaceId, cachedEvents)
}

/**
 * Patch the shared cache outside the fetch cycle — optimistic create, edit, or
 * delete from the quick-add popover, drag/resize, detail panel, or the global
 * create dialog. Return the input array unchanged to no-op. Every mounted
 * consumer is notified, and the persisted copy is updated so a quick tab
 * return doesn't resurrect the pre-edit state.
 */
export function patchCalendarEventsCache(patch: (events: IEvent[]) => IEvent[]) {
  // A chat card keeps its own events (useCalendarRangeEvents); the same edit
  // reaches them through their own patcher, never through this cache.
  rangePatchers.forEach((apply) => apply(patch))
  if (!cachedEvents) return
  const next = patch(cachedEvents)
  if (next === cachedEvents) return
  cachedEvents = next
  // The provider's truth is unknown until the next real fetch — force the next
  // baseline comparison to treat fetched data as fresh.
  cachedBaseFingerprint = null
  persistCache()
  notifyEvents(next)
}

// Per-instance range consumers (chat cards) that want the same optimistic
// edits applied to their own events. They never read or write the shared cache.
const rangePatchers = new Set<(patch: (events: IEvent[]) => IEvent[]) => void>()

// Provider (Google/Microsoft) events are fetched live from provider APIs per
// request — there's no DB table, so realtime can't push them. Poll on a visible
// tab and revalidate on focus/wake instead (see realtime-ui-sync.md Layer 3).
const POLL_INTERVAL_MS = 60_000
// On visibilitychange→visible, only refetch if the last successful fetch is
// older than this — avoids a redundant round-trip on a quick tab flip. The
// same window gates the unforced mount revalidation, which is what makes
// returning to the calendar tab free (no spinner, no network, no re-render).
const FOCUS_STALE_MS = 30_000
// Wall-clock time of the last successful fetch, shared across consumers so the
// Capture calendar and the full page agree on staleness (they share one cache).
let lastFetchAt = 0

// Shared poll timer + visibility listener, refcounted across consumers.
// Every consumer of this hook shares one filter/workspace/cache key, so N
// mounted consumers (calendar page + Capture calendar) must not each run their
// own 60s setInterval — that's N× the provider polling. Instead the first
// consumer to register arms one shared interval + one visibilitychange listener;
// the last to unregister tears them down. Each tick triggers exactly ONE fetch
// (the fetchers all target the same cache key), which refreshes the shared cache
// and notifies every consumer. Registered fetchers are kept in insertion order
// so the tick always drives a live one.
const activeFetchers = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null

function runSharedFetch() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  // One fetch per tick: all fetchers share the same cache key, so a single call
  // refreshes the shared cache for everyone. Drive the first registered fetcher.
  const fetcher = activeFetchers.values().next().value
  if (fetcher) fetcher()
}

function startSharedPolling() {
  if (pollTimer) return
  pollTimer = setInterval(runSharedFetch, POLL_INTERVAL_MS)
}

function stopSharedPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function onSharedVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    stopSharedPolling()
    return
  }
  // Back to a visible tab: catch up if stale, then resume polling.
  if (Date.now() - lastFetchAt > FOCUS_STALE_MS) runSharedFetch()
  startSharedPolling()
}

// Register a consumer's refetch callback with the shared poll machinery. The
// first registrant wires the timer + listener; the last one tears them down.
function registerFetcher(fetcher: () => void): () => void {
  const first = activeFetchers.size === 0
  activeFetchers.add(fetcher)
  if (first && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onSharedVisibilityChange)
    if (document.visibilityState === 'visible') startSharedPolling()
  }
  return () => {
    activeFetchers.delete(fetcher)
    if (activeFetchers.size === 0 && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onSharedVisibilityChange)
      stopSharedPolling()
    }
  }
}

// ── In-flight fetch dedupe ─────────────────────────────────────────────────
// Keyed by `${workspaceId}::${filterKey}` — exactly the pair the cache
// validity check uses, so two instances share a round-trip only when they
// would consume the same cache entry.
//
// Every mounted consumer (six calendar tabs plus the Capture button's calendar)
// used to run its own copy of the fetch closure, so ONE trigger — mount, poll
// tick, focus catch-up, the recovered fan-out — issued N copies of
// /api/calendar/events + /api/account/actions + POST linked-captures (measured:
// 6× on a single wake). Now the first caller starts the request and the rest
// await the SAME promise; all of them get the data through notifyEvents.
let inFlightKey: string | null = null
let inFlightPromise: Promise<IEvent[] | null> | null = null

// ── Shared-write guard ─────────────────────────────────────────────────────
// Monotonic sequence of STARTED requests. performFetch runs detached from any
// instance's generation counter, so without this the shared cache had no
// supersede check at all: a fetch for "all accounts" that resolved AFTER the
// user switched to a filtered account (or to another workspace) still wrote
// cachedEvents/cachedFilterKey/cachedWorkspaceId and called notifyEvents, and
// every consumer's listener applies setEvents unconditionally — so the stale
// payload repainted every calendar surface and poisoned the cache under the
// new key's name.
//
// A SEQUENCE, not the most-recently-requested key: key equality cannot tell
// "the key the app wants now" from "a response to an OLDER request for that
// same key". In an A→B→A supersede cycle (all accounts → one account → back to
// all accounts), the abandoned A1 response still matches the key A, so a
// key-equality guard let it commit on top of the fresher A2 data and repaint
// every consumer with stale rows.
//
// Bumped ONLY where a NEW performFetch starts (at its entry). Joiners of an
// in-flight promise for the same key deliberately do NOT bump it: they express
// the same intent as the request they join, and bumping would invalidate the
// very fetch they are waiting on.
//
// performFetch captures it at entry as `seq` and re-checks `seq ===
// latestRequestSeq` immediately before EVERY shared write (the primary commit
// incl. lastFetchAt/persistCache/notifyEvents, the prevById carry-over, the
// sameData short-circuit, and the detached linked-captures continuation); on
// mismatch it skips the writes and the notify but still RETURNS the data, so a
// caller whose own genRef is still current can use it.
let latestRequestSeq = 0

/**
 * The shared network half of a fetch: provider events + timed actions, the
 * local-Exchange merge, the identity-stable baseline comparison, the shared
 * cache writes, and the background linked-captures merge.
 *
 * Deliberately knows nothing about any instance's generation counter — the
 * per-instance "was I superseded" check lives in the caller, which owns its
 * own genRef. What it DOES enforce is `latestRequestSeq`: it claims the next
 * sequence number at entry and the shared cache writes / notifyEvents only
 * happen while it is still the newest STARTED request, so a superseded fetch
 * can't repaint every surface with data the app has already moved past — even
 * when the newer request happens to carry the same key.
 *
 * Resolves as soon as the PRIMARY result is committed — the linked-captures
 * merge runs as a detached continuation (see `mergeLinkedCaptures`), because
 * anything awaited here keeps the in-flight dedupe slot open and silently
 * swallows every poll/bus/focus trigger that lands in that window.
 *
 * Resolves to the merged events, or `null` for the "no calendar connected"
 * (HTTP 400) case, which callers translate into their own `no-provider` error.
 * Throws on any other failure.
 */
async function performFetch(
  workspaceId: string,
  accountIds: string[] | null,
  currentFilterKey: string,
): Promise<IEvent[] | null> {
  // Claim the next sequence number: from here on, any LATER performFetch
  // supersedes this one, and this one must touch nothing shared once it does.
  const seq = ++latestRequestSeq
  const now = new Date()
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
  // Exclusive: midnight starting the month after next, so the last day of next
  // month is fetched whole (month + 2, day 0 would be that day's 00:00).
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 1).toISOString()

  const fetched = await fetchCalendarWindow(workspaceId, accountIds, timeMin, timeMax, 200)
  if (fetched === null) return null
  const { calendarEvents, mapped } = fetched

  // Identity-stable refresh: when the provider payload fingerprints identically
  // to the cached baseline, keep the existing arrays/objects so consumers see
  // no change at all (a 60s poll becomes render-free). Otherwise carry
  // already-known capture links across by id — they arrive via the second
  // request below, and rebuilding without them made the capture indicators
  // blink out on every poll.
  return commitFetched(seq, workspaceId, currentFilterKey, calendarEvents, mapped)
}

/**
 * The network half of a fetch, shared by the page's cache (performFetch) and
 * a chat card's own range (useCalendarRangeEvents): provider events + timed
 * actions for one window, with the local-Exchange merge. Touches nothing
 * shared. Null for "no calendar connected" (HTTP 400); throws on any other
 * failure.
 */
async function fetchCalendarWindow(
  workspaceId: string,
  accountIds: string[] | null,
  timeMin: string,
  timeMax: string,
  maxResults: number,
): Promise<{ calendarEvents: CalendarEvent[]; mapped: IEvent[] } | null> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
  })
  params.set('workspaceId', workspaceId)
  if (accountIds?.length) params.set('accountIds', accountIds.join(','))

  // Fetch calendar events + actions in parallel
  const actionParams = new URLSearchParams({
    filter: 'all',
    status: 'active',
    due_at_min: timeMin,
    due_at_max: timeMax,
    timed_only: 'true',
  })
  const [eventsRes, actionsRes] = await Promise.all([
    fetch(`/api/calendar/events?${params}`),
    fetch(`/api/account/actions?${actionParams}`).catch(() => null),
  ])

  if (!eventsRes.ok) {
    if (eventsRes.status === 400) return null
    throw new Error('Failed to fetch events')
  }
  const data = await eventsRes.json()
  const serverEvents = data.events as CalendarEvent[]
  // Merge local Exchange events (desktop only, no-op on web)
  const calendarEvents = await mergeWithLocalExchangeEvents(serverEvents, timeMin, timeMax, accountIds, workspaceId)
  let mapped = calendarEvents.map(calendarEventToIEvent)

  // Merge timed actions
  try {
    if (actionsRes?.ok) {
      const actionsData = await actionsRes.json()
      const actionEvents = (actionsData.actions as { id: string; identifier: string; title: string; due_at: string; priority: string; all_day: boolean }[])
        .filter((a) => a.due_at && !a.all_day)
        .map(actionToIEvent)
      mapped = [...mapped, ...actionEvents]
    }
  } catch {
    // Non-blocking
  }
  return { calendarEvents, mapped }
}

/** performFetch's shared commit: the identity-stable comparison, the cache writes and the capture merge. */
function commitFetched(
  seq: number,
  workspaceId: string,
  currentFilterKey: string,
  calendarEvents: CalendarEvent[],
  mapped: IEvent[],
): IEvent[] {
  const baseFingerprint = fingerprintBaseline(mapped)
  // Superseded while the network was open (filter switch, workspace switch, or
  // simply a newer request for the SAME key): return what we fetched so a
  // still-current caller can use it, but touch NOTHING shared — no cache write,
  // no notify.
  const stillCurrent = seq === latestRequestSeq
  const sameData =
    stillCurrent &&
    cachedBaseFingerprint !== null &&
    baseFingerprint.length === cachedBaseFingerprint.length &&
    baseFingerprint.hash === cachedBaseFingerprint.hash &&
    cachedWorkspaceId === workspaceId &&
    cachedFilterKey === currentFilterKey &&
    !!cachedEvents
  let current: IEvent[]
  if (sameData) {
    current = cachedEvents!
  } else {
    const prevById =
      stillCurrent && cachedEvents && cachedWorkspaceId === workspaceId
        ? new Map(cachedEvents.map((e) => [e.id, e]))
        : null
    current = prevById
      ? mapped.map((e) => {
          const prev = prevById.get(e.id)
          return prev?.linkedCapture ? { ...e, linkedCapture: prev.linkedCapture } : e
        })
      : mapped
    if (stillCurrent) {
      cachedEvents = current
      cachedBaseFingerprint = baseFingerprint
      cachedFilterKey = currentFilterKey
      cachedWorkspaceId = workspaceId
      persistCache()
      notifyEvents(current)
    }
  }
  if (stillCurrent) lastFetchAt = Date.now()

  // Linked captures merge DETACHED: awaiting the POST here would keep the
  // in-flight dedupe slot open for its whole duration, so every poll tick,
  // bus mutation and focus catch-up landing in that window would "join" a
  // promise that issues no request of its own and is never deferred —
  // measured as ten consecutive 60s poll ticks producing ZERO events fetches
  // with the POST held open. Fire and forget: it re-validates this request's
  // sequence number itself and reaches consumers through notifyEvents.
  if (stillCurrent && calendarEvents.length) {
    void mergeLinkedCaptures(
      seq,
      current,
      calendarEvents.map((e) => e.id),
    )
  }

  return current
}

/**
 * Background half of a fetch: resolve linked captures for the events just
 * committed and merge them into the shared cache. Runs detached from
 * performFetch's promise (see above), so it re-validates its request's
 * sequence number itself before writing anything shared.
 */
async function mergeLinkedCaptures(seq: number, current: IEvent[], eventIds: string[]): Promise<void> {
  try {
    const captureRes = await fetch('/api/account/calendar/linked-captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_ids: eventIds }),
    })
    if (!captureRes.ok) return
    const captureMap = (await captureRes.json()) as Record<string, IEventCapture>
    // The POST can easily outlive a filter or workspace switch (or just a
    // newer fetch for the same key) — a merge on top of the superseded
    // request's events would overwrite fresher data in the shared cache.
    if (seq !== latestRequestSeq) return
    // Merge preserving identity per event — an unchanged capture link
    // (the common case) must not churn the object, or every poll would
    // re-render the whole grid twice.
    let changed = false
    const withCaptures = current.map((event) => {
      const cap = captureMap[event.id]
      const prevCap = event.linkedCapture
      if (!cap && !prevCap) return event
      if (cap && prevCap && JSON.stringify(cap) === JSON.stringify(prevCap)) return event
      changed = true
      if (!cap) {
        const { linkedCapture: _omit, ...rest } = event
        return rest as IEvent
      }
      return { ...event, linkedCapture: cap }
    })
    // Only patch if the primary commit we built on is still the cache — a
    // newer fetch for the same key may have replaced it while we were open.
    if (changed && cachedEvents === current) {
      cachedEvents = withCaptures
      persistCache()
      notifyEvents(withCaptures)
    }
  } catch {
    // Non-blocking — calendar works without capture data
  }
}

export interface UseCalendarEvents {
  events: IEvent[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  filterAccountIds: string[] | null
  setFilterAccountIds: (ids: string[] | null) => void
}

export function useCalendarEvents(): UseCalendarEvents {
  const workspaceId = useWorkspaceId()
  const [events, setEvents] = useState<IEvent[]>(() => {
    if (cachedEvents && cachedWorkspaceId === workspaceId) return cachedEvents
    // Cold start (full page load): paint the previous session's events now and
    // revalidate in the background, instead of spinning on the provider
    // round-trip. Only for the default filter — the only one persisted.
    if (workspaceId && getFilterSnapshot() === null) {
      const persisted = readPersistedEvents(workspaceId)
      if (persisted) {
        cachedEvents = persisted
        cachedWorkspaceId = workspaceId
        cachedFilterKey = ''
        cachedBaseFingerprint = null
        // Placeholder, never fresh — the mount fetch must still revalidate.
        lastFetchAt = 0
        return persisted
      }
    }
    return []
  })
  const [loading, setLoading] = useState(() => !(cachedEvents && cachedWorkspaceId === workspaceId))
  const [error, setError] = useState<string | null>(null)
  // Shared across all consumers (calendar page + Capture calendar) so they show the same
  // selection and share one fetch/cache key.
  const filterAccountIds = useSyncExternalStore(subscribeFilter, getFilterSnapshot, getFilterSnapshot)
  const setFilterAccountIds = setFilterAccountIdsShared

  const hasLoadedOnce = useRef(!!(cachedEvents && cachedWorkspaceId === workspaceId))

  // Cold app load: the workspace CONTEXT only resolves after the workspaces
  // fetch (1-2s), but the last-active workspace id is already in localStorage.
  // Hydrate that workspace's persisted events before first paint instead of
  // showing a spinner while the context loads. Layout effect: client-only and
  // pre-paint, so it can't diverge from server-rendered HTML and never flashes
  // the spinner. If the context later resolves to a different workspace (rare),
  // the normal key-mismatch fetch path replaces the cache.
  useLayoutEffect(() => {
    if (workspaceId || cachedEvents) return
    if (getFilterSnapshot() !== null) return
    const clientWorkspaceId = getClientWorkspaceId()
    if (!clientWorkspaceId) return
    const persisted = readPersistedEvents(clientWorkspaceId)
    if (!persisted) return
    cachedEvents = persisted
    cachedWorkspaceId = clientWorkspaceId
    cachedFilterKey = ''
    cachedBaseFingerprint = null
    lastFetchAt = 0
    setEvents(persisted)
    setLoading(false)
    hasLoadedOnce.current = true
    // Mount-only: this is strictly a cold-start fast path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Per-instance request generation: gate this consumer's own writes so a
  // superseded fetch (e.g. the old filter's slow background hydration) can't
  // clobber the newer one. Per-instance (not module-global) so two concurrent
  // consumers don't invalidate each other's writes — both write identical data
  // to the shared cache anyway (last-write-wins, benign).
  const genRef = useRef(0)

  const fetchEvents = useCallback(async (opts?: { force?: boolean; recovered?: boolean }) => {
    // Wait until workspace context is available
    if (!workspaceId) return

    const currentFilterKey = filterAccountIds?.slice().sort().join(',') ?? ''

    // `recovered` = this call came from 'ni:realtime-recovered', which fires
    // on every wake (use-realtime-entities latches hadFailure on any ≥30s hide,
    // even when the socket was healthy). The visibility/focus wave already
    // force-fetches on the same wake, so without this the two waves each issue
    // a round-trip seconds apart. A recovered refetch carries no information of
    // its own — it only means "you may have missed events" — so it is
    // redundant when a fetch for this exact key just completed, or when one is
    // already in flight for it (which the join below would handle anyway; this
    // exits sooner and avoids the spurious setLoading).
    //
    // Deliberately NOT applied to real calendar_event bus mutations: those
    // carry actual news and must not be delayed up to FOCUS_STALE_MS.
    if (
      opts?.recovered &&
      cachedEvents &&
      cachedWorkspaceId === workspaceId &&
      cachedFilterKey === currentFilterKey &&
      (Date.now() - lastFetchAt < FOCUS_STALE_MS ||
        (inFlightPromise !== null && inFlightKey === `${workspaceId}::${currentFilterKey}`))
    ) {
      return
    }

    // No usable in-memory cache for this workspace (cold page load — the
    // workspace id resolves after first render — or a workspace switch):
    // surface the persisted copy immediately, then revalidate below. Runs in
    // an effect, so it can't diverge from server-rendered HTML.
    if ((!cachedEvents || cachedWorkspaceId !== workspaceId) && currentFilterKey === '') {
      const persisted = readPersistedEvents(workspaceId)
      if (persisted) {
        cachedEvents = persisted
        cachedWorkspaceId = workspaceId
        cachedFilterKey = ''
        cachedBaseFingerprint = null
        // Persisted data is a placeholder, never fresh — without this, the
        // previous workspace's recent fetch time would let the freshness check
        // below skip revalidating what we just hydrated.
        lastFetchAt = 0
        notifyEvents(persisted)
        setEvents(persisted)
        setLoading(false)
        hasLoadedOnce.current = true
      }
    }

    // Fresh-enough shared cache for the same key → skip the network entirely.
    // Only the unforced mount revalidation takes this path; polls, bus events,
    // focus catch-ups and manual refetches all pass force.
    if (
      !opts?.force &&
      cachedEvents &&
      cachedWorkspaceId === workspaceId &&
      cachedFilterKey === currentFilterKey &&
      Date.now() - lastFetchAt < FOCUS_STALE_MS
    ) {
      setEvents(cachedEvents)
      setError(null)
      setLoading(false)
      hasLoadedOnce.current = true
      return
    }

    // Stamp this request against THIS instance. Anything this run writes to
    // instance state is gated on the generation still matching, so a superseded
    // fetch (the old filter's slow response) can't clobber a newer one. The
    // shared cache/notify half lives in performFetch and is gated separately by
    // the module-level `latestRequestSeq` — a monotonic counter over STARTED
    // requests, so an abandoned response can never commit over a newer one even
    // when both carry the same key.
    const gen = ++genRef.current

    // Show cached data immediately if filter hasn't changed
    if (!hasLoadedOnce.current || currentFilterKey !== cachedFilterKey) {
      if (!cachedEvents || currentFilterKey !== cachedFilterKey) setLoading(true)
    }
    setError(null)

    const key = `${workspaceId}::${currentFilterKey}`
    // Join an in-flight request for the SAME key instead of starting a second
    // one — this is what collapses the N-instance wake storm into one
    // round-trip. Joiners receive the data through notifyEvents either way, and
    // deliberately do NOT bump `latestRequestSeq`: joining expresses the same
    // intent as the request being joined, so bumping would supersede the very
    // fetch this call is waiting on and suppress its cache write.
    let promise: Promise<IEvent[] | null>
    if (inFlightPromise && inFlightKey === key) {
      promise = inFlightPromise
    } else {
      promise = performFetch(workspaceId, filterAccountIds, currentFilterKey)
      inFlightKey = key
      inFlightPromise = promise
      // Only clear if WE are still the current in-flight request: a newer call
      // for the same key started after this one settled must not have its
      // promise clobbered by this stale finally.
      promise
        .catch(() => {})
        .finally(() => {
          if (inFlightPromise === promise) {
            inFlightPromise = null
            inFlightKey = null
          }
        })
    }

    try {
      const result = await promise
      // A newer fetch superseded this one for THIS instance — drop it.
      if (gen !== genRef.current) return
      if (result === null) {
        setError('no-provider')
        return
      }
      setEvents(result)
    } catch {
      if (gen === genRef.current) setError('Failed to load calendar events')
    } finally {
      if (gen === genRef.current) {
        setLoading(false)
        hasLoadedOnce.current = true
      }
    }
  }, [filterAccountIds, workspaceId])

  // Reset the (shared, module-scoped) account filter when the workspace changes:
  // account ids belong to a workspace, so a filter from workspace A would filter
  // workspace B's calendar to non-existent accounts (empty calendar). Only the
  // first mounted consumer that observes the switch performs the reset; the
  // module-level guard makes concurrent consumers idempotent.
  const prevWorkspaceRef = useRef(workspaceId)
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspaceId) {
      prevWorkspaceRef.current = workspaceId
      if (getFilterSnapshot() !== null) setFilterAccountIdsShared(null)
    }
  }, [workspaceId])

  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  // Receive shared-cache updates made by OTHER consumers or by out-of-band
  // patches (optimistic create/edit/delete), so every mounted calendar surface
  // repaints together instead of waiting for its own next fetch.
  useEffect(() => {
    const listener = (next: IEvent[]) => {
      setEvents(next)
      setLoading(false)
      hasLoadedOnce.current = true
    }
    eventListeners.add(listener)
    return () => {
      eventListeners.delete(listener)
    }
  }, [])

  // Keep a stable ref to the latest fetchEvents so the shared polling machinery
  // always drives the current closure without re-registering every time the
  // filter or workspace changes (which would restart the poll timer).
  const fetchRef = useRef(fetchEvents)
  fetchRef.current = fetchEvents

  // Visible-window polling + focus revalidation. Provider events have no
  // realtime source, so this is how the calendar catches teammate/agent/
  // provider-side writes. The timer + visibilitychange listener are SHARED
  // across all mounted consumers (refcounted at module scope) — one 60s
  // interval total, not one per consumer — and each tick drives a single fetch
  // against the shared cache key. There are no dashboard tabs any more (one
  // chat: docs/plans/one-chat.md), so every mounted consumer is on screen and
  // registers; when the last one unmounts, the timer stops.
  useEffect(() => {
    const wrapped = () => fetchRef.current({ force: true })
    return registerFetcher(wrapped)
  }, [])

  // Bus sync for the local_calendar_event-backed rows (desktop Exchange sync),
  // which now flow through Supabase Realtime → the entity bus. Forced: the bus
  // only fires when server data actually changed, so the freshness window must
  // not swallow it — and it is NOT subject to the recovered recency guard for
  // the same reason.
  //
  // refetchOnRecovered: false — the recovered catch-up is handled by the
  // dedicated listener below, which needs to distinguish itself from a real
  // mutation in order to apply the recency guard.
  const busFetch = useCallback(() => {
    fetchEvents({ force: true })
  }, [fetchEvents])
  useEntityListSync(['calendar_event'], busFetch, { refetchOnRecovered: false })

  // 'ni:realtime-recovered' catch-up, registered directly so it can be
  // tagged `recovered` (see the recency guard in fetchEvents).
  //
  // useEntityListSync's 300 ms recovered debounce is deliberately dropped
  // here: the in-flight slot is claimed SYNCHRONOUSLY before fetchEvents'
  // first await, so a same-task fan-out across every mounted consumer still
  // collapses to one round-trip without waiting out a timer.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onRecovered = () => fetchRef.current({ force: true, recovered: true })
    window.addEventListener('ni:realtime-recovered', onRecovered)
    return () => window.removeEventListener('ni:realtime-recovered', onRecovered)
  }, [])

  const forcedFetch = useCallback(() => fetchEvents({ force: true }), [fetchEvents])

  return { events, loading, error, refetch: forcedFetch, filterAccountIds, setFilterAccountIds }
}

/**
 * True for an event a card shows: overlapping [timeMin, timeMax) and, when the
 * card filters by accounts, on one of them. A timed action is on no account.
 */
function inRange(event: IEvent, timeMin: string, timeMax: string, accountsKey: string): boolean {
  const start = Date.parse(event.startDate)
  const end = Date.parse(event.endDate)
  if (!Number.isNaN(start) && start >= Date.parse(timeMax)) return false
  if (!Number.isNaN(end) && (end > start ? end <= Date.parse(timeMin) : start < Date.parse(timeMin))) return false
  if (!accountsKey || event.isAction) return true
  return !!event.accountId && accountsKey.split(',').includes(event.accountId)
}

export interface UseCalendarRangeEvents {
  events: IEvent[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
}

/**
 * One calendar range for one consumer: a chat card's own events
 * (docs/plans/one-agent-and-chat-pages.md, P2).
 *
 * The card shows whatever day, week or month it was given and the person
 * moves it to, filtered to its own accounts, so it never shares the page's
 * window, its module cache, its account filter or its poll: it reads and
 * writes none of them, and a card moving its date or switching accounts never
 * changes what the Calendar page or the Capture button's calendar show. It
 * hears the same realtime bus and the same optimistic edits
 * (patchCalendarEventsCache), applied to its own events.
 *
 * `timeMin` / `timeMax` are the range's instants (local midnights); the card
 * computes them from its dates.
 */
export function useCalendarRangeEvents(timeMin: string, timeMax: string, accountIds: string[] | null): UseCalendarRangeEvents {
  const workspaceId = useWorkspaceId()
  const [events, setEvents] = useState<IEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const genRef = useRef(0)
  const accountsKey = accountIds?.slice().sort().join(',') ?? ''

  const fetchRange = useCallback(async () => {
    if (!workspaceId) return
    const gen = ++genRef.current
    setError(null)
    try {
      const fetched = await fetchCalendarWindow(workspaceId, accountsKey ? accountsKey.split(',') : null, timeMin, timeMax, 250)
      if (gen !== genRef.current) return
      if (fetched === null) {
        setError('no-provider')
        return
      }
      setEvents(fetched.mapped)
      // Capture links, as the page shows them: this card's events only.
      if (fetched.calendarEvents.length) {
        void fetch('/api/account/calendar/linked-captures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_ids: fetched.calendarEvents.map((e) => e.id) }),
        })
          .then((res) => (res.ok ? (res.json() as Promise<Record<string, IEventCapture>>) : null))
          .then((captures) => {
            if (!captures || gen !== genRef.current) return
            setEvents((prev) => prev.map((e) => (captures[e.id] ? { ...e, linkedCapture: captures[e.id] } : e)))
          })
          .catch(() => {})
      }
    } catch {
      if (gen === genRef.current) setError('Failed to load calendar events')
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [workspaceId, timeMin, timeMax, accountsKey])

  useEffect(() => {
    void fetchRange()
  }, [fetchRange])

  // The same optimistic edits the page's cache takes, applied to this range:
  // what the edit leaves is kept only when it is this card's (in its window,
  // on its accounts), so an event added for next month or on another
  // account never lands here, and one moved out of the range leaves.
  useEffect(() => {
    const apply = (patch: (events: IEvent[]) => IEvent[]) =>
      setEvents((prev) => patch(prev).filter((e) => inRange(e, timeMin, timeMax, accountsKey)))
    rangePatchers.add(apply)
    return () => {
      rangePatchers.delete(apply)
    }
  }, [timeMin, timeMax, accountsKey])

  // Desktop Exchange rows and other writes reach every calendar through the bus.
  useEntityListSync(['calendar_event'], fetchRange)

  return { events, loading, error, refetch: fetchRange }
}
