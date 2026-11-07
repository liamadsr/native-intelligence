'use client'

/**
 * The entity tab's data (plan Part 2.1, row 10): the route's rows, kept live.
 *
 *   - `work_touch` filtered on `entity_id` (a column, so the filter works): a
 *     touch on a work item already listed patches that row in place (its verbs,
 *     tools and time); a touch from a work item not listed yet (a new run, or
 *     one whose row the tab has not read) refetches, debounced.
 *   - `tracked_job` UPDATE, unfiltered with RLS as the fence (the ledger's own
 *     pattern): a listed row's status moves with it (a run finishing without a
 *     further touch still reads "Done"). Rows not listed are ignored.
 *   - on an action, `agent_run` filtered on `action_id`: a new run on the
 *     action refetches (a coding run writes no touches).
 *   - a channel recovery refetches.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  markSelfRefetched,
  repairIdFromRecoveredEvent,
  wasSelfRefetchedRecently,
} from '@/lib/supabase/realtime-recovery'
import { useRowChanges } from './use-row-changes'
import { addTouch, type TouchLike } from '@/lib/work/touch-summary'
import type { EntityActivityRow, EntityActivityType } from '@/lib/work/entity-activity'
import type { WorkItem } from '@/lib/work/types'

export const entityActivityUrl = (type: string, id: string) =>
  `/api/account/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/activity`

const DEBOUNCE_MS = 400
let mountSeq = 0

export interface EntityActivityState {
  /** Null until the first load. */
  rows: EntityActivityRow[] | null
  hidden: number
  failed: boolean
  refresh: () => Promise<void>
}

interface TouchPayload extends TouchLike {
  entity_type?: string
  entity_id?: string
}

export function useEntityActivity(entityType: EntityActivityType, entityId: string | null): EntityActivityState {
  const [rows, setRows] = useState<EntityActivityRow[] | null>(null)
  const [hidden, setHidden] = useState(0)
  const [failed, setFailed] = useState(false)
  const rowsRef = useRef<EntityActivityRow[] | null>(null)
  const channelName = useRef('')
  if (!channelName.current) channelName.current = `entity-activity-${++mountSeq}`

  const setList = useCallback((next: EntityActivityRow[] | null) => {
    rowsRef.current = next
    setRows(next)
  }, [])

  // Only the latest load may land: a slower earlier one (the previous entity's,
  // or a superseded refetch) would otherwise write its rows over the new ones.
  const loadSeq = useRef(0)
  const refresh = useCallback(async () => {
    if (!entityId) return
    const seq = ++loadSeq.current
    try {
      const res = await fetch(entityActivityUrl(entityType, entityId), { cache: 'no-store' })
      if (seq !== loadSeq.current) return
      if (!res.ok) {
        setFailed(true)
        return
      }
      const data = (await res.json()) as { rows?: EntityActivityRow[]; hidden?: number }
      if (seq !== loadSeq.current) return
      setList(Array.isArray(data.rows) ? data.rows : [])
      setHidden(typeof data.hidden === 'number' ? data.hidden : 0)
      setFailed(false)
    } catch {
      if (seq === loadSeq.current) setFailed(true)
    }
  }, [entityType, entityId, setList])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    // Supersede any load still in flight for the previous entity (refresh bumps
    // the sequence too; this covers an entity change to null, which loads nothing).
    loadSeq.current++
    setList(null)
    setHidden(0)
    setFailed(false)
    void refresh()
  }, [refresh, setList])

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bump = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void refreshRef.current(), DEBOUNCE_MS)
  }, [])
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current)
    },
    [],
  )

  useRowChanges<TouchPayload>({
    table: 'work_touch',
    filter: entityId ? `entity_id=eq.${entityId}` : null,
    events: ['INSERT'],
    onRow: (touch) => {
      if (touch.entity_type && touch.entity_type !== entityType) return
      const list = rowsRef.current
      if (!list) return
      const i = list.findIndex((r) => r.work_item_id === touch.work_item_id)
      if (i < 0) {
        bump()
        return
      }
      const patched = { ...list[i], ...addTouch(list[i], touch) }
      const next = [patched, ...list.slice(0, i), ...list.slice(i + 1)]
      next.sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
      setList(next)
    },
    onResync: () => void refreshRef.current(),
  })

  // An action's own runs (entity-activity.ts): a new one starts with no touch
  // on the action, so its insert is the signal. agent_run is member-readable,
  // hence the filter (never an open channel on it; plan 1.3).
  useRowChanges<{ id: string }>({
    table: 'agent_run',
    filter: entityType === 'action' && entityId ? `action_id=eq.${entityId}` : null,
    events: ['INSERT'],
    onRow: () => bump(),
    onResync: () => void refreshRef.current(),
  })

  useEffect(() => {
    if (!entityId) return
    const CHANNEL = `${channelName.current}:ledger`
    let hadFailure = false
    const supabase = createClient()
    const channel = supabase
      .channel(CHANNEL)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tracked_job' }, (payload: { new?: unknown }) => {
        const item = payload.new as WorkItem | undefined
        const list = rowsRef.current
        if (!item?.id || !list) return
        const i = list.findIndex((r) => r.work_item_id === item.id)
        if (i < 0) return
        // The payload carries the teammate's id, not its embed: keep the one we have.
        const next = [...list]
        next[i] = { ...list[i], work_item: { ...item, teammate: list[i].work_item.teammate } }
        setList(next)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && hadFailure) {
          hadFailure = false
          markSelfRefetched(CHANNEL)
          void refreshRef.current()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          hadFailure = true
        }
      })
    const onRecovered = (event: Event) => {
      if (wasSelfRefetchedRecently(CHANNEL, repairIdFromRecoveredEvent(event))) return
      void refreshRef.current()
    }
    window.addEventListener('dial8:realtime-recovered', onRecovered)
    return () => {
      window.removeEventListener('dial8:realtime-recovered', onRecovered)
      supabase.removeChannel(channel)
    }
  }, [entityId, setList])

  return { rows, hidden, failed, refresh }
}
