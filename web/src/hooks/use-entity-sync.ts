'use client'

/**
 * One-line live-sync adoption for any surface that renders entity data.
 *
 * The entity event bus (src/lib/entity-events.ts) already carries every
 * mutation — local, cross-tab, and teammate/server-side via Supabase Realtime
 * (use-realtime-entities.ts). These hooks are the listener side: they turn
 * bus events into a debounced refetch (lists) or an id-matched patch/close
 * (detail panels), plus a catch-up refetch on `dial8:realtime-recovered` so
 * a surface never stays stale after a dropped-then-restored socket.
 *
 * Use useEntityListSync for anything that renders a collection; use
 * useEntityDetailSync for anything pinned to a single record. Both keep the
 * latest callbacks in refs, so callers can pass inline closures without
 * churning subscriptions.
 */

import { useEffect, useRef } from 'react'
import { wasRecentlyMutatedLocally, type EntityKind, type EntityUpdatedDetail } from '@/lib/entity-events'

interface ListSyncOptions {
  /** Trailing debounce for refetches — coalesces bursts (e.g. a batch MCP
   *  create firing N INSERT events). Default 300ms. */
  debounceMs?: number
  /** Optional predicate on created/updated/deleted details. Return false to
   *  ignore an event (e.g. a comments list only cares about events whose
   *  fields.commentable_id matches its own).
   *
   *  IMPORTANT: realtime DELETE payloads carry ONLY the primary key (Supabase
   *  strips the old row regardless of replica identity), so `fields` will be
   *  empty on deletes. Scope predicates must pass when the scoping key is
   *  absent — `d.fields?.x == null || d.fields.x === mine` — or real deletes
   *  are silently dropped and the list goes stale. */
  match?: (detail: { entityType: EntityKind; id?: string; fields?: Record<string, unknown> }) => boolean
  /** Set false to opt out of the realtime-recovered catch-up refetch.
   *  Default true — opt out only if a parent already refetches this data. */
  refetchOnRecovered?: boolean
  /** Disable all listeners (e.g. while the surface is hidden). */
  enabled?: boolean
}

/**
 * Refetch a list when any entity of the given kinds is created, updated, or
 * deleted anywhere (this tab, another tab, a teammate, an MCP tool, a cron),
 * and after a realtime reconnect (events during the gap were lost).
 */
export function useEntityListSync(
  kinds: EntityKind[],
  refetch: () => void,
  opts?: ListSyncOptions,
) {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  const matchRef = useRef(opts?.match)
  matchRef.current = opts?.match
  const debounceMs = opts?.debounceMs ?? 300
  const refetchOnRecovered = opts?.refetchOnRecovered ?? true
  const enabled = opts?.enabled ?? true
  // Key by contents, not array identity — callers pass inline literals.
  const kindsKey = kinds.join(',')

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const kindSet = new Set(kindsKey.split(',').filter(Boolean))

    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refetchRef.current()
      }, debounceMs)
    }

    const onEntityEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        entityType: EntityKind
        id?: string
        fields?: Record<string, unknown>
      }
      if (!detail || !kindSet.has(detail.entityType)) return
      if (matchRef.current && !matchRef.current(detail)) return
      schedule()
    }
    const onRecovered = () => {
      if (refetchOnRecovered) schedule()
    }

    window.addEventListener('dial8:entity-created', onEntityEvent)
    window.addEventListener('dial8:entity-updated', onEntityEvent)
    window.addEventListener('dial8:entity-deleted', onEntityEvent)
    window.addEventListener('dial8:realtime-recovered', onRecovered)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('dial8:entity-created', onEntityEvent)
      window.removeEventListener('dial8:entity-updated', onEntityEvent)
      window.removeEventListener('dial8:entity-deleted', onEntityEvent)
      window.removeEventListener('dial8:realtime-recovered', onRecovered)
    }
  }, [kindsKey, debounceMs, refetchOnRecovered, enabled])
}

interface DetailSyncHandlers {
  /** Patch the open record in place with the changed columns. If omitted and
   *  `refetch` is provided, updates trigger a (debounced) refetch instead. */
  onUpdated?: (fields: Record<string, unknown>) => void
  /** The open record was deleted — close the panel / navigate away. */
  onDeleted?: () => void
  /** Full reload of the record. Used for updates without onUpdated, and for
   *  the realtime-recovered catch-up (a patch can't recover missed events). */
  refetch?: () => void
}

/**
 * Keep a single open record (detail panel, editor header, etc.) in sync:
 * id-matched updates patch or refetch, an id-matched delete closes, and a
 * realtime reconnect refetches to catch anything missed during the gap.
 *
 * Self-echo protection: update events for a record THIS tab just mutated
 * (per wasRecentlyMutatedLocally — armed by emitting entity events after
 * local PATCHes) are skipped, so a panel's own save doesn't round-trip into
 * a refetch that clobbers whatever the user is still editing. Panels should
 * therefore emitEntityUpdated after their own successful writes.
 */
export function useEntityDetailSync(
  kind: EntityKind,
  id: string | null | undefined,
  handlers: DetailSyncHandlers,
  opts?: { debounceMs?: number },
) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  // Coalesces refetch bursts (a server-side writer updating several columns
  // in quick succession fires one UPDATE event per statement).
  const debounceMs = opts?.debounceMs ?? 250

  useEffect(() => {
    if (!id || typeof window === 'undefined') return

    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefetch = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        handlersRef.current.refetch?.()
      }, debounceMs)
    }

    const onUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail as EntityUpdatedDetail
      if (!d || d.entityType !== kind || d.id !== id) return
      if (wasRecentlyMutatedLocally(kind, id)) return
      const h = handlersRef.current
      if (h.onUpdated) h.onUpdated(d.fields)
      else if (h.refetch) scheduleRefetch()
    }
    const onDeleted = (e: Event) => {
      const d = (e as CustomEvent).detail as { entityType: EntityKind; id: string }
      if (!d || d.entityType !== kind || d.id !== id) return
      handlersRef.current.onDeleted?.()
    }
    const onRecovered = () => {
      if (handlersRef.current.refetch) scheduleRefetch()
    }

    window.addEventListener('dial8:entity-updated', onUpdated)
    window.addEventListener('dial8:entity-deleted', onDeleted)
    window.addEventListener('dial8:realtime-recovered', onRecovered)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('dial8:entity-updated', onUpdated)
      window.removeEventListener('dial8:entity-deleted', onDeleted)
      window.removeEventListener('dial8:realtime-recovered', onRecovered)
    }
  }, [kind, id, debounceMs])
}
