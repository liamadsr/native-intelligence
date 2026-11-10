'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { createLoadRetry, type LoadOutcome } from '@/lib/load-retry'
import {
  markSelfRefetched,
  wasSelfRefetchedRecently,
  repairIdFromRecoveredEvent,
} from '@/lib/supabase/realtime-recovery'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { stopRouteOf } from '@/lib/work/agent-work-lanes'
import { upsertWorkRow } from '@/lib/work/patch-rows'
import type { AiLimitedTeammate, CardRunRow, LightDoneRow, LightWorkRow } from '@/lib/work/queries'
import { isWorkLive, type WorkItem } from '@/lib/work/types'
import { LIGHT_READS_BREAKERS } from '@/lib/work/light-read'
import { aiLimitedTeammates, type AiLimited } from '@/lib/bots/crew-state'
import { onTeammatesChanged } from '@/lib/bots/teammates-changed'
import { announceWorkTransition, type WorkRowLike } from '@/lib/sounds/triggers'
import { isInWorkspaceSpan } from '@/lib/workspace-span'
import { noteWorkRow } from '@/lib/sounds/teammate-work'

/**
 * What the bots show (AgentWorkProvider holds the one instance, in the
 * dashboard shell): the light read of the work and the roster across every
 * workspace the caller belongs to (GET /api/account/agent-work?light=1), kept
 * live. The light read is the open rows in light columns, the last day's runs
 * that finished done with something made (with what a "done" peek needs:
 * bots-v4 Phase 4b, so the peek survives a reload), the rows pending cards
 * point at, and the roster with its breakers.
 *
 * Realtime (plan §1.3's cross-workspace channel): one channel on `tracked_job`
 * INSERT/UPDATE with NO row filter. RLS is the fence, and today it delivers
 * only the caller's own rows. A pushed row is admitted when its WORKSPACE is
 * one the route answered for (`workspace_ids`), not its member. So the day the
 * SELECT policy widens, the bots show the workspace's rows with no change
 * here, the same as its query. The channel name is unique per mount:
 * supabase-js hands back the same channel object for a repeated topic, so two
 * mounts sharing a name would let either unmount tear the other down.
 *
 * The pushed row is patched in (the payload is the full row). An attempt that
 * was just dismissed reloads (debounced) while the light read carries the
 * breakers (LIGHT_READS_BREAKERS): its role's "Attempts paused" may have
 * changed. A push that lands while a reload is in flight is re-applied on top
 * of its answer.
 *
 * Sounds (bots-v4.md Phase 4a; the header's ledger hook played them until
 * then): the channel's handler is the only thing that plays the "run
 * finished" sound and notes whose each row is. An UPDATE's edge (running →
 * done) plays agent-complete (announceWorkTransition). Under RLS the payload's
 * old record is `{ id }` alone, so the previous status is the last one this
 * hook saw for the id: from a load, an INSERT, or an earlier
 * UPDATE, whatever the row's workspace. A row first seen in an UPDATE has no
 * previous status and plays nothing; a run already going at mount is learned
 * from the load, or else from its first silent running → running write (a
 * step or heartbeat). A run a light answer no longer holds is forgotten
 * (learnStatuses), so a finish nobody heard never chimes late. Every pushed
 * row is also noted for whose it is (noteWorkRow): a notification or a card
 * about it that arrives next plays its AI teammate's sound (bots-v2 Phase 6).
 * The alert gates (src/lib/sounds/alerts.ts) make it one sound across
 * windows. The provider mounts this hook once in the shell, so the sound is
 * asked for once a window.
 *
 * reviewed / dismissReview are the item's own verbs (PATCH
 * /api/account/activity/[id]), applied optimistically. answered is a
 * question's: its answer went through the run's respond route
 * (RunQuestionSection), and its row leaves waiting at once. stop calls the row's
 * cancel route (agent-work-lanes.ts stopRouteOf) with the ROW'S workspace as
 * `x-workspace-id`, because the bots span workspaces.
 *
 * The answer carries who the AI usage limit stopped (`ai_limited`, read at
 * `ai_limited_as_of`): `aiLimited` is that answer moved on by every row held
 * that started or settled after it (crew-state.ts aiLimitedTeammates: a run
 * stopped by the limit stops its teammate, any other run wakes it), so a bot
 * falls asleep, and wakes, as its runs are pushed; and aged every
 * AI_LIMIT_AGE_MS while anyone's stopped, so a stop lifts once it's 48 hours
 * old with no reload. Null until an answer has said (the bot's page falls
 * back to its own last row then).
 * The `tracked_job` channel is ONE for the life of the mount. Every load waits
 * for it to be SUBSCRIBED (a row written between the load's read and the
 * subscription would be in neither), except that realtime being down or slow
 * never holds the data back: it loads anyway after SUBSCRIBE_WAIT_MS, and
 * loads again once the channel is up. `rows` is whatever is held, which is
 * what the counts read. A teammate a pushed row names that the list can't
 * name reloads nothing: the light read names no one. `enabled: false` holds
 * off the loads and the channel.
 *
 * A failed load retries by itself (2 s, 8 s, 30 s, then every 2 minutes;
 * `@/lib/load-retry`), and at once when the window comes back into view or
 * focus. Signed out (a 401 twice running), it waits the long interval every
 * time and the window events leave it be. A load that lands resets the
 * backoff.
 *
 * `onWorkRow` hands the channel on to whoever keeps rows of their own (a
 * bot's work, use-bot-work.ts, bots-v4.md Phase 1a), so nothing opens a
 * second `tracked_job` channel: every row it delivers, whatever its
 * workspace, and `resync` each time the channel comes up (or
 * back after realtime recovered), when a listener reloads whatever it may
 * have missed.
 */
/** What `onWorkRow` listeners hear: a row the channel delivered (the whole row, no teammate embed), or that it came up again. */
export type WorkRowEvent = { type: 'row'; row: WorkItem } | { type: 'resync' }
export type WorkRowListener = (event: WorkRowEvent) => void
/** Listens to the shell's `tracked_job` channel until the returned function runs. */
export type OnWorkRow = (listener: WorkRowListener) => () => void

export interface AgentWork {
  /**
   * Every row held (what the per-teammate counts read): the answer's open
   * rows and its done rows (LightDoneRow, which say what they made), and
   * whatever was pushed since. Null until the first load.
   */
  rows: ReadonlyArray<WorkItem | LightWorkRow | LightDoneRow> | null
  /** The rows the pending attention cards point at that `rows` may not hold (route `card_rows`, with `opened_at`). */
  cardRows: CardRunRow[]
  roster: RosterTeammate[]
  workspaceIds: string[]
  currentWorkspaceId: string | null
  loading: boolean
  /** The last load failed (an agent's page says so instead of an empty list). */
  failed: boolean
  refresh: () => Promise<void>
  reviewed: (workId: string) => Promise<{ ok: boolean }>
  dismissReview: (workId: string) => Promise<void>
  /**
   * A question answered (the run's respond route took it: RunQuestionSection's
   * `onResumed`): its row leaves waiting at once, as that route left its run
   * (queued), till the ledger's own UPDATE lands. No fetch: the answer was the
   * route's.
   */
  answered: (workId: string) => void
  stop: (item: WorkItem) => Promise<void>
  /** Rows whose Stop was sent and that have not settled yet. */
  stopping: ReadonlySet<string>
  /**
   * "Resume role" (plan Part 5 row 9): reset a role's paused attempts in one
   * workspace, then reload the roster so the chip clears. False when it failed.
   */
  resumeRole: (workspaceId: string, role: string) => Promise<boolean>
  /** The ledger channel's rows, for a reader that keeps its own (stable for the mount). */
  onWorkRow: OnWorkRow
  /**
   * The teammates the AI usage limit has stopped, by id, with when (see the
   * doc): their bots sleep, and their bubble, page and list entry say why.
   * Null until an answer has said.
   */
  aiLimited: AiLimited | null
}

/** The route: `?light=1` here, `?teammate=` for one bot (use-bot-work.ts). */
export const AGENT_WORK_URL = '/api/account/agent-work'
/** How often who the AI limit stopped is aged, while anyone is (a stop lifts 48 hours on). */
export const AI_LIMIT_AGE_MS = 5 * 60 * 1000
export const AGENT_WORK_LIGHT_URL = `${AGENT_WORK_URL}?light=1`
export const AGENT_AUTONOMY_RESUME_URL = '/api/account/workspace/agent-autonomy/resume'
const DEBOUNCE_MS = 400
/** How long a load waits for the ledger channel to come up before it goes anyway. */
export const SUBSCRIBE_WAIT_MS = 3000
/**
 * Bound on the last-status memory (least recently written goes first). An
 * answer holds up to 350 rows (300 open, queries.ts listOpenWorkInWorkspaces,
 * and LIGHT_DONE_LIMIT done), so the bound holds a whole answer and the
 * pushes after it.
 */
export const MAX_TRACKED_STATUSES = 1000
let mountSeq = 0

/** Remember `status` as `id`'s latest (most recent write last in the map): the "before" of a later UPDATE. */
function trackStatus(statuses: Map<string, string>, id: unknown, status: unknown): void {
  if (typeof id !== 'string' || !id || typeof status !== 'string') return
  statuses.delete(id)
  statuses.set(id, status)
  if (statuses.size > MAX_TRACKED_STATUSES) {
    const oldest = statuses.keys().next().value
    if (oldest !== undefined) statuses.delete(oldest)
  }
}

/**
 * What a load teaches the memory (the sounds, see the doc). An answer is
 * newest first, so it's learned oldest first: the bound, reached, lets the
 * oldest rows go, never the newest runs. An answer holds every open row, so a
 * row last seen live (one a finish could chime out of) that it doesn't hold
 * settled while nothing was listening (the channel down, or not up yet when
 * an early load went): it's forgotten, so its next write (an open stamp, say)
 * can't chime minutes late.
 */
function learnStatuses(statuses: Map<string, string>, list: readonly WorkItem[]): void {
  const held = new Set(list.map((row) => row.id))
  for (const [id, status] of statuses) {
    if (isWorkLive(status) && !held.has(id)) statuses.delete(id)
  }
  for (let i = list.length - 1; i >= 0; i--) trackStatus(statuses, list[i].id, list[i].status)
}

interface AgentWorkResponse {
  items?: WorkItem[]
  card_rows?: CardRunRow[]
  roster?: RosterTeammate[]
  workspace_ids?: string[]
  current_workspace_id?: string
  ai_limited?: AiLimitedTeammate[]
  ai_limited_as_of?: string
}

/** Who the AI limit stopped, as an answer said, and when it read that. */
interface AiLimitAnswer {
  list: AiLimitedTeammate[]
  asOf: string | null
}
const NO_AI_LIMIT_ANSWER: AiLimitAnswer = { list: [], asOf: null }

export function useAgentWork(opts: { enabled?: boolean } = {}): AgentWork {
  const enabled = opts.enabled ?? true
  // The list holds light rows (typed as WorkItem inside this hook only).
  const [items, setItems] = useState<WorkItem[] | null>(null)
  const [cardRows, setCardRows] = useState<CardRunRow[]>([])
  const [roster, setRoster] = useState<RosterTeammate[]>([])
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const [aiLimitAnswer, setAiLimitAnswer] = useState<AiLimitAnswer>(NO_AI_LIMIT_ANSWER)

  const workspaceIdsRef = useRef<Set<string> | null>(null)
  const itemsRef = useRef<WorkItem[] | null>(null)
  const inFlight = useRef(0)
  const pushedDuringFetch = useRef(new Map<string, WorkItem>())
  // The last status seen per row id: the "before" of an UPDATE (the sounds, see the doc).
  const lastStatus = useRef(new Map<string, string>())
  // The ledger channel, as far as the loads go (see the load effect).
  const subscribedRef = useRef(false)
  const loadWaiting = useRef(false)
  const loadedEarly = useRef(false)
  // The retry schedule (see settleLoad).
  const liveRef = useRef(false)
  const failedRef = useRef(false)
  const [retry] = useState(() => createLoadRetry(() => void refreshRef.current()))
  // Who else hears the ledger channel (onWorkRow).
  const [rowListeners] = useState(() => new Set<WorkRowListener>())
  const onWorkRow = useCallback<OnWorkRow>(
    (listener) => {
      rowListeners.add(listener)
      return () => {
        rowListeners.delete(listener)
      }
    },
    [rowListeners],
  )

  const setList = useCallback((list: WorkItem[]) => {
    itemsRef.current = list
    setItems(list)
    // A Stop is done once its row has left the live statuses.
    setStopping((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => list.some((it) => it.id === id && isWorkLive(it.status))))
      return next.size === prev.size ? prev : next
    })
  }, [])

  /**
   * After a load that was not dropped: a landed one clears the failure and the
   * backoff; a failed one (an HTTP status, or 'network') schedules the next try.
   */
  const settleLoad = useCallback(
    (outcome: LoadOutcome) => {
      if (!liveRef.current) return
      if (outcome === 'ok') {
        retry.reset()
        failedRef.current = false
        setFailed(false)
        return
      }
      failedRef.current = true
      setFailed(true)
      retry.failed(outcome)
    },
    [retry],
  )

  const refresh = useCallback(async () => {
    inFlight.current += 1
    setLoading(true)
    let outcome: LoadOutcome | null = null
    try {
      const res = await fetch(AGENT_WORK_LIGHT_URL, { cache: 'no-store' })
      if (!res.ok) {
        outcome = res.status
        return
      }
      const data = (await res.json()) as AgentWorkResponse
      const ids = Array.isArray(data.workspace_ids) ? data.workspace_ids : []
      workspaceIdsRef.current = new Set(ids)
      // A push that landed while this load was in flight is newer than the
      // answer's read of that row: re-applied over it.
      let list = Array.isArray(data.items) ? data.items : []
      let nextCardRows = Array.isArray(data.card_rows) ? data.card_rows : []
      for (const row of pushedDuringFetch.current.values()) {
        if (!workspaceIdsRef.current.has(row.workspace_id)) continue
        list = upsertWorkRow(list, row).list
        nextCardRows = nextCardRows.map((r) => (r.id === row.id ? row : r))
      }
      setList(list)
      learnStatuses(lastStatus.current, list)
      setCardRows(nextCardRows)
      setRoster(Array.isArray(data.roster) ? data.roster : [])
      setWorkspaceIds(ids)
      setCurrentWorkspaceId(data.current_workspace_id ?? null)
      setAiLimitAnswer({
        list: Array.isArray(data.ai_limited) ? data.ai_limited : [],
        asOf: typeof data.ai_limited_as_of === 'string' ? data.ai_limited_as_of : null,
      })
      outcome = 'ok'
    } catch {
      outcome = 'network'
    } finally {
      inFlight.current -= 1
      if (inFlight.current === 0) pushedDuringFetch.current.clear()
      setLoading(false)
      if (outcome !== null) settleLoad(outcome)
    }
  }, [setList, settleLoad])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // The retries belong to this mount while it is enabled.
  useEffect(() => {
    liveRef.current = enabled
    return () => {
      liveRef.current = false
      retry.cancel()
    }
  }, [enabled, retry])

  // The ledger channel: one for the life of the mount.
  useEffect(() => {
    if (!enabled) return
    // Unique per mount: two mounts sharing a topic would share one channel
    // object in supabase-js, and either unmount would tear the other down.
    const CHANNEL = `agent-work-${++mountSeq}`
    let hadFailure = false
    let closed = false
    let debounce: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void refreshRef.current(), DEBOUNCE_MS)
    }
    // A listener that throws never stops the rest, or this hook's own patch.
    const emit = (event: WorkRowEvent) => {
      for (const listener of [...rowListeners]) {
        try {
          listener(event)
        } catch (err) {
          console.error('[agent-work] a work-row listener failed:', err)
        }
      }
    }
    const onRow = (payload: { new?: unknown }) => {
      const row = payload.new as WorkItem | undefined
      if (!row?.id) return
      emit({ type: 'row', row })
      // Kept for the load in flight, which admits it by the workspaces it
      // answers for (the first load's are not known until it lands).
      if (inFlight.current > 0) pushedDuringFetch.current.set(row.id, row)
      if (!workspaceIdsRef.current?.has(row.workspace_id)) return
      // A row a pending card points at: its owner is read off it.
      setCardRows((prev) => (prev.some((r) => r.id === row.id) ? prev.map((r) => (r.id === row.id ? row : r)) : prev))
      if (!itemsRef.current) return
      setList(upsertWorkRow(itemsRef.current, row).list)
      // A dismissed attempt may have tripped its role's breaker: reloaded
      // while the light read carries the breakers (bots-v4 Phase 4b:
      // "Attempts paused" on the bots, attempts dismissed from the bubble).
      const attemptDismissed = row.origin === 'attempt' && row.progress?.review === 'dismissed'
      if (attemptDismissed && LIGHT_READS_BREAKERS) bump()
    }
    // The sounds, before the row is patched in (see the doc). A sound that
    // throws never stops the patch.
    const hear = (event: 'INSERT' | 'UPDATE', payload: { new?: unknown; old?: unknown }) => {
      try {
        const next = payload.new as WorkRowLike | undefined
        noteWorkRow(next)
        const id = next?.id
        if (event === 'UPDATE' && id) {
          // The old record carries only the id under RLS: the "before" is the last status seen here.
          const old = payload.old as WorkRowLike | undefined
          const prevStatus = typeof old?.status === 'string' ? old.status : lastStatus.current.get(id)
          // Silent for a run in a workspace the app isn't showing ("Show all
          // workspaces" off, lib/workspace-span): its row is held but not on screen.
          const workspaceId = (payload.new as { workspace_id?: string } | undefined)?.workspace_id
          if (isInWorkspaceSpan(workspaceId)) {
            announceWorkTransition(next, prevStatus === undefined ? null : { id, status: prevStatus })
          }
        }
        trackStatus(lastStatus.current, id, next?.status)
      } catch (err) {
        console.error('[agent-work] the run sounds failed:', err)
      }
      onRow(payload)
    }
    const supabase = createClient()
    const channel = supabase
      .channel(CHANNEL)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tracked_job' }, (payload: { new?: unknown }) =>
        hear('INSERT', payload),
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tracked_job' }, (payload: { new?: unknown; old?: unknown }) =>
        hear('UPDATE', payload),
      )
      .subscribe((status) => {
        if (closed) return
        if (status === 'SUBSCRIBED') {
          subscribedRef.current = true
          // A load waiting on the channel goes now; one that went early (it
          // waited too long) goes again, for what landed in between.
          const reload = hadFailure || loadWaiting.current || loadedEarly.current
          if (hadFailure) markSelfRefetched(CHANNEL)
          hadFailure = false
          loadWaiting.current = false
          loadedEarly.current = false
          if (reload) void refreshRef.current()
          // Up (again): a listener reloads what landed before it could hear it.
          emit({ type: 'resync' })
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          subscribedRef.current = false
          hadFailure = true
          // Realtime is down: a load waiting on it goes now, and the
          // re-SUBSCRIBE loads again.
          if (loadWaiting.current) {
            loadWaiting.current = false
            void refreshRef.current()
          }
        }
      })
    const onRecovered = (event: Event) => {
      if (wasSelfRefetchedRecently(CHANNEL, repairIdFromRecoveredEvent(event))) return
      void refreshRef.current()
      emit({ type: 'resync' })
    }
    window.addEventListener('ni:realtime-recovered', onRecovered)
    return () => {
      closed = true
      subscribedRef.current = false
      loadedEarly.current = false
      if (debounce) clearTimeout(debounce)
      window.removeEventListener('ni:realtime-recovered', onRecovered)
      supabase.removeChannel(channel)
    }
  }, [enabled, setList, rowListeners])

  // The first load, once the ledger channel is up (or SUBSCRIBE_WAIT_MS has
  // passed).
  useEffect(() => {
    if (!enabled) return
    failedRef.current = false
    setFailed(false)
    retry.reset()
    if (subscribedRef.current) {
      void refreshRef.current()
      return
    }
    loadWaiting.current = true
    const wait = setTimeout(() => {
      if (!loadWaiting.current) return
      loadWaiting.current = false
      loadedEarly.current = true
      void refreshRef.current()
    }, SUBSCRIBE_WAIT_MS)
    return () => {
      clearTimeout(wait)
      loadWaiting.current = false
    }
  }, [enabled, retry])

  // A failed load also retries the moment the window is back in view or
  // focus (both fire on a return: the second finds the first in flight).
  // Not while signed out: the long interval is enough.
  useEffect(() => {
    if (!enabled) return
    const retryNow = () => {
      if (!failedRef.current || inFlight.current > 0) return
      if (retry.signedOut) return
      if (document.visibilityState === 'hidden') return
      retry.cancel()
      void refreshRef.current()
    }
    window.addEventListener('focus', retryNow)
    document.addEventListener('visibilitychange', retryNow)
    return () => {
      window.removeEventListener('focus', retryNow)
      document.removeEventListener('visibilitychange', retryNow)
    }
  }, [enabled, retry])

  // A teammate made or changed (a custom agent's bot, a built face, a voice or
  // a name saved in the agent editor), in this window or another of the app's:
  // the roster reloads, so the bots show it and speak in it straight away.
  useEffect(() => {
    if (!enabled) return
    return onTeammatesChanged(() => void refreshRef.current())
  }, [enabled])

  const settle = useCallback(
    async (workId: string, action: 'reviewed' | 'dismiss'): Promise<{ ok: boolean }> => {
      const list = itemsRef.current ?? []
      const snapshot = list.find((it) => it.id === workId)
      if (snapshot) {
        // What settleReview writes (resolve.ts); the realtime UPDATE confirms it.
        const settled: WorkItem = {
          ...snapshot,
          status: 'done',
          needs: null,
          reviewed_at: new Date().toISOString(),
          progress: { ...(snapshot.progress ?? {}), review: action === 'reviewed' ? 'reviewed' : 'dismissed' },
        }
        setList(upsertWorkRow(list, settled).list)
      }
      const restore = () => {
        if (snapshot && itemsRef.current) setList(upsertWorkRow(itemsRef.current, snapshot).list)
      }
      try {
        const res = await fetch(`/api/account/activity/${workId}`, {
          method: 'PATCH',
          // No workspace header: the route admits a row from any of the caller's memberships.
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (res.ok || res.status === 404) return { ok: res.ok }
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        restore()
        toast.error(action === 'reviewed' ? 'Could not mark it reviewed' : 'Could not dismiss', {
          description: err?.error || 'Something went wrong',
        })
        return { ok: false }
      } catch (e) {
        restore()
        toast.error('Network error', { description: e instanceof Error ? e.message : undefined })
        return { ok: false }
      }
    },
    [setList],
  )

  const reviewed = useCallback((workId: string) => settle(workId, 'reviewed'), [settle])
  const dismissReview = useCallback(async (workId: string) => {
    await settle(workId, 'dismiss')
  }, [settle])

  const answered = useCallback(
    (workId: string) => {
      const list = itemsRef.current ?? []
      const snapshot = list.find((it) => it.id === workId)
      if (!snapshot || snapshot.status !== 'needs_input') return
      setList(upsertWorkRow(list, { ...snapshot, status: 'queued', needs: null }).list)
    },
    [setList],
  )

  const stop = useCallback(async (item: WorkItem) => {
    const url = stopRouteOf(item)
    if (!url) return
    setStopping((prev) => new Set(prev).add(item.id))
    const clear = () =>
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'x-workspace-id': item.workspace_id } })
      if (!res.ok) {
        clear()
        // 409: it settled before the Stop landed — the row's own update shows how.
        if (res.status !== 409) toast.error('Could not stop this run')
        return
      }
      toast('Stopping the run')
    } catch {
      clear()
      toast.error('Could not stop this run')
    }
  }, [])

  const resumeRole = useCallback(async (workspaceId: string, role: string) => {
    try {
      const res = await fetch(AGENT_AUTONOMY_RESUME_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
        body: JSON.stringify({ role, workspace_id: workspaceId }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(d.error ?? 'Could not resume this role')
        return false
      }
      await refreshRef.current()
      return true
    } catch {
      toast.error('Could not resume this role')
      return false
    }
  }, [])

  // Who the AI limit stopped, now (see the doc): the same map until who, or
  // since when, changes, not at every push; aged every AI_LIMIT_AGE_MS while
  // anyone's stopped (`aiAge` ticks), so a 48-hour-old stop lifts by itself.
  const [aiAge, setAiAge] = useState(0)
  const aiLimitedKey = useMemo(() => {
    const stopped = aiLimitedTeammates(aiLimitAnswer.list, aiLimitAnswer.asOf, items, Date.now())
    return [...stopped].map(([id, at]) => `${id}@${at}`).sort().join(',')
    // `aiAge` is the clock moving on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiLimitAnswer, items, aiAge])
  useEffect(() => {
    if (!aiLimitedKey) return
    const timer = setInterval(() => setAiAge((n) => n + 1), AI_LIMIT_AGE_MS)
    return () => clearInterval(timer)
  }, [aiLimitedKey])
  const aiLimitKnown = aiLimitAnswer.asOf !== null
  const aiLimited = useMemo<AiLimited | null>(
    () =>
      aiLimitKnown
        ? new Map(
            aiLimitedKey
              ? aiLimitedKey.split(',').map((pair): [string, string] => {
                  const at = pair.indexOf('@')
                  return [pair.slice(0, at), pair.slice(at + 1)]
                })
              : [],
          )
        : null,
    [aiLimitKnown, aiLimitedKey],
  )

  return useMemo(
    () => ({
      rows: items,
      cardRows,
      roster,
      workspaceIds,
      currentWorkspaceId,
      loading,
      failed,
      refresh,
      reviewed,
      dismissReview,
      answered,
      stop,
      stopping,
      resumeRole,
      onWorkRow,
      aiLimited,
    }),
    [items, cardRows, roster, workspaceIds, currentWorkspaceId, loading, failed, refresh, reviewed, dismissReview, answered, stop, stopping, resumeRole, onWorkRow, aiLimited],
  )
}
