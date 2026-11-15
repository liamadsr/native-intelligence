'use client'

/**
 * One local agent session, live, for the Agents panel (contract G): the
 * session across its turns, as long as the panel is mounted (and only then:
 * nothing here runs for a panel that isn't drawn).
 *
 * - First, the newest page of its events (EVENTS_PAGE, read with the browser
 *   client under owner RLS), then GET /api/local-agent/sessions/[id] after
 *   it: the session row (reaped) and anything newer. Older pages come on
 *   demand (`loadEarlier`, "Show earlier"), stitched in front.
 * - Then realtime: INSERTs on local_agent_event (`session_id=eq.<id>`) and
 *   UPDATEs on local_agent_session (`id=eq.<id>`), each one filtered channel
 *   (useRowChanges, owner RLS), with its resync on a recovered channel.
 * - A poll catches up (`afterId` = the last id held) while the realtime side
 *   has been quiet: every 2 s while it works (queued, starting, running),
 *   every 6 s while it idles or was interrupted, never once it ended, and
 *   never in a hidden document. A GET also reaps a lapsed lease, so a Mac
 *   that went away shows as interrupted.
 * - Events are batched once per frame (rAF, with a 250 ms timer for a hidden
 *   webview where rAF doesn't fire) into the pure fold (transcript-view.ts),
 *   which keeps no raw events, dedupes by id and keeps unchanged items'
 *   objects, so a streaming delta re-renders one row. A late commit (an
 *   unseen id below the newest) reads the session again from its newest
 *   page, in the server's order. No requestIdleCallback (a WebKit idle trap).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRowChanges } from '@/hooks/use-row-changes'
import { createClient } from '@/lib/supabase/client'
import type { LocalAgentPolicy } from '@/lib/tauri-bridge'
import type { LocalAgentStatus } from '@/lib/local-agent/store'
import {
  applyStoredEvents,
  emptySessionTranscript,
  isSessionEnded,
  prependStoredEvents,
  type SessionTranscript,
  type StoredEventLike,
} from '@/lib/local-agent/transcript-view'
import {
  eventFromRow,
  fetchEventsBefore,
  fetchSessionSince,
  postSessionMessage,
  postSessionStop,
  sessionFromRow,
  type PanelSession,
} from './session-api'

/** A hidden webview never runs rAF; this timer flushes instead. */
const FLUSH_FALLBACK_MS = 250
/** Catch-up poll while it works, and while it idles. */
export const POLL_WORKING_MS = 2_000
export const POLL_IDLE_MS = 6_000

const WORKING: ReadonlySet<LocalAgentStatus> = new Set(['queued', 'starting', 'running'])

/** How often the catch-up poll runs for a status (null: not at all). */
export function pollIntervalFor(status: LocalAgentStatus | null | undefined): number | null {
  if (!status || isSessionEnded(status)) return null
  return WORKING.has(status) ? POLL_WORKING_MS : POLL_IDLE_MS
}

/** The newer of two reads of the session (by updatedAt; the later read wins a tie). */
function newer(held: PanelSession | null, read: PanelSession): PanelSession {
  if (!held || held.id !== read.id) return read
  const a = Date.parse(held.updatedAt)
  const b = Date.parse(read.updatedAt)
  if (Number.isFinite(a) && Number.isFinite(b) && a > b) return held
  return read
}

type Sent = { ok: true } | { ok: false; message: string }

export interface LocalAgentSessionState {
  session: PanelSession | null
  transcript: SessionTranscript
  /** The first read is out. */
  loading: boolean
  /** The session couldn't be read (gone, not yours, offline). */
  error: string | null
  /** Stop was asked and the session hasn't ended yet. */
  stopping: boolean
  /** Older events than the ones held may be on the server. */
  hasEarlier: boolean
  loadingEarlier: boolean
  /** Read the page before the oldest event held. */
  loadEarlier: () => Promise<void>
  /** `requestId`: one per submit; a retry with the same one sends once. */
  send: (text: string, policy: LocalAgentPolicy, requestId: string) => Promise<Sent>
  stop: () => Promise<Sent>
}

export function useLocalAgentSession(sessionId: string): LocalAgentSessionState {
  const [session, setSession] = useState<PanelSession | null>(null)
  const [transcript, setTranscript] = useState<SessionTranscript>(() => emptySessionTranscript(sessionId))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stopAsked, setStopAsked] = useState(false)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // Bumped to read the session again (a late commit).
  const [reloads, setReloads] = useState(0)

  const held = transcript.sessionId === sessionId
  const lastIdRef = useRef(0)
  lastIdRef.current = held ? transcript.lastId : 0
  const firstIdRef = useRef(0)
  firstIdRef.current = held ? transcript.firstId : 0
  const pendingRef = useRef<StoredEventLike[]>([])
  const loadingRef = useRef(true)
  const reloadsRef = useRef(0)
  reloadsRef.current = reloads
  const rafRef = useRef<number | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHeardRef = useRef(0)
  const catchingUpRef = useRef<Promise<void> | null>(null)
  const againRef = useRef(false)
  const earlierRef = useRef(false)
  const liveRef = useRef(true)

  const flush = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
    rafRef.current = null
    flushTimerRef.current = null
    // A read applies first; live rows wait for it.
    if (loadingRef.current) return
    const batch = pendingRef.current.splice(0)
    if (batch.length === 0) return
    setTranscript((t) => (t.sessionId === sessionId ? applyStoredEvents(t, batch) : t))
  }, [sessionId])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null || flushTimerRef.current !== null) return
    rafRef.current = requestAnimationFrame(flush)
    flushTimerRef.current = setTimeout(flush, FLUSH_FALLBACK_MS)
  }, [flush])

  /** Read what came after the last id held (one read at a time; a call meanwhile reads again after). */
  const catchUp = useCallback((): Promise<void> => {
    if (loadingRef.current) return Promise.resolve()
    if (catchingUpRef.current) {
      againRef.current = true
      return catchingUpRef.current
    }
    const run = (async () => {
      do {
        againRef.current = false
        const res = await fetchSessionSince(sessionId, lastIdRef.current)
        if (!liveRef.current) return
        if (!res.ok) break
        setSession((s) => newer(s, res.value.session))
        pendingRef.current.push(...res.value.events)
        flush()
      } while (againRef.current && liveRef.current)
    })().finally(() => {
      catchingUpRef.current = null
    })
    catchingUpRef.current = run
    return run
  }, [sessionId, flush])

  // The read: the newest page, then the route after it. A reload (a late
  // commit) keeps showing what's held until the new read replaces it.
  useEffect(() => {
    liveRef.current = true
    loadingRef.current = true
    const first = reloads === 0
    if (first) {
      pendingRef.current = []
      setLoading(true)
      setError(null)
      setSession(null)
      setStopAsked(false)
      setHasEarlier(false)
      setTranscript(emptySessionTranscript(sessionId))
    }
    void (async () => {
      const newest = await fetchEventsBefore(createClient(), sessionId, null)
      if (!liveRef.current) return
      const page = newest.ok ? newest.value.events : []
      // Without the page read, the route from the start (the whole session, forward).
      const after = newest.ok && page.length > 0 ? page[page.length - 1].id : 0
      const res = await fetchSessionSince(sessionId, after)
      if (!liveRef.current) return
      loadingRef.current = false
      setLoading(false)
      if (!res.ok) {
        if (first) setError(res.message)
        return
      }
      setSession((s) => newer(s, res.value.session))
      setHasEarlier(newest.ok ? newest.value.more : false)
      const all = [...page, ...res.value.events, ...pendingRef.current.splice(0)]
      setTranscript(applyStoredEvents(emptySessionTranscript(sessionId), all))
    })()
    return () => {
      liveRef.current = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
      // Null, or a StrictMode remount would think a flush is still scheduled.
      rafRef.current = null
      flushTimerRef.current = null
    }
  }, [sessionId, reloads])

  // A late commit landed: read it again in the server's order.
  const stale = held && transcript.stale
  useEffect(() => {
    if (stale) setReloads((n) => n + 1)
  }, [stale])

  const loadEarlier = useCallback(async () => {
    const before = firstIdRef.current
    if (earlierRef.current || loadingRef.current || before <= 0) return
    earlierRef.current = true
    setLoadingEarlier(true)
    const at = reloadsRef.current
    try {
      const res = await fetchEventsBefore(createClient(), sessionId, before)
      // A reload meanwhile holds a different window: this page no longer joins it.
      if (!liveRef.current || !res.ok || reloadsRef.current !== at) return
      setTranscript((t) => (t.sessionId === sessionId ? prependStoredEvents(t, res.value.events) : t))
      setHasEarlier(res.value.more)
    } finally {
      earlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [sessionId])

  useRowChanges<Record<string, unknown>>({
    table: 'local_agent_event',
    filter: `session_id=eq.${sessionId}`,
    events: ['INSERT'],
    onRow: (row) => {
      const event = eventFromRow(row, sessionId)
      if (!event) return
      lastHeardRef.current = Date.now()
      pendingRef.current.push(event)
      scheduleFlush()
    },
    onResync: () => void catchUp(),
  })
  useRowChanges<Record<string, unknown>>({
    table: 'local_agent_session',
    filter: `id=eq.${sessionId}`,
    events: ['UPDATE'],
    onRow: (row) => {
      lastHeardRef.current = Date.now()
      setSession((s) => (s ? sessionFromRow(s, row) : s))
    },
    onResync: () => void catchUp(),
  })

  // The catch-up poll, while the realtime side is quiet and the document shows.
  const interval = pollIntervalFor(session?.status)
  useEffect(() => {
    if (interval === null) return
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (Date.now() - lastHeardRef.current < interval) return
      void catchUp()
    }, interval)
    return () => clearInterval(t)
  }, [interval, catchUp])

  const ended = !!session && isSessionEnded(session.status)
  useEffect(() => {
    if (ended) setStopAsked(false)
  }, [ended])

  const send = useCallback(
    async (text: string, policy: LocalAgentPolicy, requestId: string): Promise<Sent> => {
      const res = await postSessionMessage(sessionId, text, policy, requestId)
      if (!res.ok) return { ok: false, message: res.message }
      // Its `inbound` event is stored: show it now rather than at the next poll.
      void catchUp()
      return { ok: true }
    },
    [sessionId, catchUp],
  )

  const stop = useCallback(async (): Promise<Sent> => {
    setStopAsked(true)
    const res = await postSessionStop(sessionId)
    if (!res.ok) {
      setStopAsked(false)
      return { ok: false, message: res.message }
    }
    const read = res.value
    if (read) setSession((s) => newer(s, read))
    void catchUp()
    return { ok: true }
  }, [sessionId, catchUp])

  return {
    session,
    transcript,
    loading,
    error,
    stopping: stopAsked && !ended,
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    send,
    stop,
  }
}
