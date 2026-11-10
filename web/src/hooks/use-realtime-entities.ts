'use client'

/**
 * useRealtimeEntities — subscribe to Supabase Realtime postgres_changes for
 * every list-rendered entity and translate them into the existing
 * `dial8:entity-*` window events. Listeners (UnifiedViewLayout, detail panels,
 * etc.) get teammate-driven updates through the same code path as in-tab
 * mutations — no new wiring at call sites.
 *
 * Workspace scoping is enforced server-side via RLS; the workspace_id filter
 * here is a perf optimisation so we don't receive irrelevant events for other
 * workspaces (even though RLS would block them).
 *
 * Re-broadcast is suppressed because every tab in the same browser also gets
 * its own realtime fan-out, so the BroadcastChannel mirror would just cause
 * duplicate dispatches.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getLastRepairId, requestRecovery } from '@/lib/supabase/realtime-recovery'
import {
  emitEntityCreated,
  emitEntityDeleted,
  emitEntityUpdated,
  wasRecentlyMutatedLocally,
  type EntityKind,
} from '@/lib/entity-events'
import { REALTIME_ENTITY_TABLES } from '@/lib/knowledge/entity-registry'

// Table → emitted entity kind: every registry kind with `realtime: true`
// (src/lib/knowledge/entity-registry.ts), plus the two bindings that are not
// an entity's own table, listed below.
//
// `filtered: false` marks tables without a workspace_id column (scoped via
// team_id or a parent row instead). Those subscribe UNFILTERED: RLS still
// gates INSERT/UPDATE delivery to authorized subscribers.
//
// DELETE events (empirically verified on DEV, 2026-07-09): Supabase ignores
// filters for DELETEs and delivers every delete on the table to every
// subscriber, with `old` stripped to the PK regardless of replica identity.
// So deletes can arrive for rows outside this workspace — listeners remove
// by id, which is a no-op for rows they aren't showing.
//
// Every table here must be in the supabase_realtime publication and have
// REPLICA IDENTITY FULL (migration 187_realtime_sync_coverage.sql) — FULL
// identity is what puts the complete OLD row on UPDATE payloads, which
// listeners like the notification unread-count delta rely on, and what the
// UPDATE handler's diff (changedFields below) compares against to forward
// only genuinely changed columns.
//
// email_thread_index is intentionally excluded: it churns heavily during
// email sync (every fetched thread = an UPDATE), and broadcasting each one
// would saturate the bus. email-layout.tsx runs its own narrowly-scoped
// channel for the inbox instead. email_message is excluded for the same
// reason — the thread's index-row UPDATE is the client signal.
//
// Eval cases and runs stream as their own kinds, not only through the suite
// row: the suite detail page's Cases and Runs tabs are scoped views over the
// CHILD tables, so a case authored by the assistant or a trial settling
// mid-run has to reach those lists as an event about the child.
export const TABLES: ReadonlyArray<{ table: string; entityType: EntityKind; filtered: boolean }> = [
  ...REALTIME_ENTITY_TABLES,
  // An edge, not an entity: graph panels repaint off link inserts/deletes.
  { table: 'entity_link', entityType: 'entity_link', filtered: true },
  // Membership changes repaint the team itself, so they emit kind 'team' with
  // the TEAM's id (eventId below). No workspace_id column.
  { table: 'team_member', entityType: 'team', filtered: false },
]

// ── Cross-workspace actions and projects ─────────────────────────────────
//
// With the workspace menu's "Show all workspaces" switch on, the My Actions and
// Projects lists (ViewConfig.workspace_scope === 'all') render rows from every
// workspace the user belongs to, but this channel's `actions` and `projects`
// bindings are filtered to the ACTIVE workspace — so a teammate's edit in
// another workspace would never reach the open list, and the row would sit
// stale until the next refetch. While any such list is mounted, its table's
// binding drops its filter and relies on RLS instead, which is the attention
// rail's existing pattern for the same problem (`use-attention-items.ts`
// subscribes `attention_item` unfiltered: RLS delivers only rows the caller
// may read, across every workspace).
//
// THE TRADE-OFF, stated plainly: an unfiltered binding is broader than the
// list that asked for it. The user is served an event for every row
// they can read in any of their workspaces — including workspaces no mounted
// list is showing — and each one costs a diff plus a `dial8:entity-updated`
// dispatch that most listeners drop on the id check. RLS still gates delivery,
// so nothing leaks; what widens is FAN-OUT, and only for a user who has
// deliberately asked to see every workspace at once. It narrows again the
// moment the last such list unmounts or toggles back, which is why this is
// ref-counted rather than a one-way latch: two lists in personal scope must
// not have one's unmount re-narrow the other's.
//
// Only `actions` and `projects` widen. Nothing else in TABLES has a
// cross-workspace consumer, and `action_assignee` (which the row's assignee
// chips come from) has no binding here at all — an assignee change lands as an
// `actions` UPDATE through the row's own columns. Each table is held on its
// own, so a Projects list in personal scope widens `projects` and nothing else.
export type CrossWorkspaceTable = 'actions' | 'projects'
const crossWorkspaceHolders: Record<CrossWorkspaceTable, number> = { actions: 0, projects: 0 }
const crossWorkspaceListeners = new Set<() => void>()

/**
 * Ask the shared entity channel for an UNFILTERED binding on `table`, and get
 * back the release. Call from an effect
 * (`return acquireCrossWorkspaceTable('projects')`) so unmount and dependency
 * changes both release exactly one hold.
 */
export function acquireCrossWorkspaceTable(table: CrossWorkspaceTable): () => void {
  crossWorkspaceHolders[table] += 1
  if (crossWorkspaceHolders[table] === 1) notifyCrossWorkspace()
  let released = false
  return () => {
    // Idempotent: React can invoke an effect cleanup only once, but a caller
    // holding the fn is free to be sloppy, and a double release would strand
    // the count below zero and pin the binding wide forever.
    if (released) return
    released = true
    crossWorkspaceHolders[table] -= 1
    if (crossWorkspaceHolders[table] === 0) notifyCrossWorkspace()
  }
}

/** `acquireCrossWorkspaceTable('actions')`. */
export function acquireCrossWorkspaceActions(): () => void {
  return acquireCrossWorkspaceTable('actions')
}

/** Is at least one mounted list currently showing `table`'s rows across workspaces? */
export function isCrossWorkspaceTableEnabled(table: CrossWorkspaceTable): boolean {
  return crossWorkspaceHolders[table] > 0
}

/** Is at least one mounted list currently showing actions across workspaces? */
export function isCrossWorkspaceActionsEnabled(): boolean {
  return isCrossWorkspaceTableEnabled('actions')
}

/** The widened tables as one comparable value (a useSyncExternalStore snapshot). */
function crossWorkspaceTablesKey(): string {
  return (Object.keys(crossWorkspaceHolders) as CrossWorkspaceTable[])
    .filter(isCrossWorkspaceTableEnabled)
    .join(',')
}

function isWidenedIn(key: string, table: string): boolean {
  return key !== '' && key.split(',').includes(table)
}

function notifyCrossWorkspace() {
  for (const listener of crossWorkspaceListeners) listener()
}

function subscribeCrossWorkspace(listener: () => void): () => void {
  crossWorkspaceListeners.add(listener)
  return () => {
    crossWorkspaceListeners.delete(listener)
  }
}

// team_member rows are membership edges — the entity the UI cares about is
// the team itself, so those events emit kind 'team' with the TEAM's id.
function eventId(table: string, row: RealtimeRow): string | undefined {
  if (table === 'team_member') return (row.team_id as string | undefined) ?? (row.id as string | undefined)
  return row.id as string | undefined
}

interface RealtimeRow { id?: string; workspace_id?: string; team_id?: string; [key: string]: unknown }

// ── UPDATE payload diffing ───────────────────────────────────────────────
// Scoping columns forwarded on EVERY update of a table whether or not they
// changed. Listeners read these to decide "is this event about MY parent
// row?" (the comments thread matches fields.commentable_id, the capture
// panel's participants list matches capture_participant.capture_id, …) —
// diffing an unchanged scope key away would make those listeners mis-scope
// the event (strict predicates drop it and go stale; loose ones over-match
// and over-refetch). Deliberately PER-TABLE, not one flat list: a key like
// project_id is a CHANGE signal on the view-rendered tables (unified-view-
// layout refetches joined display data when it appears in fields) but a
// scope key on milestone — flattening would re-break the presence check
// this diff exists to fix. workspace_id is kept for every table.
const SCOPE_COLUMNS: Record<string, string[]> = {
  comment: ['commentable_id', 'commentable_type'],
  flow_run: ['flow_id'],
  capture_participant: ['capture_id'],
  milestone: ['project_id'],
  cycle: ['team_id'],
  contact_interaction: ['contact_id'],
  entity_link: ['source_id', 'target_id'],
  email_draft: ['provider_thread_id'],
  team_member: ['team_id'],
  // Listeners scope enrollment events to the sequence detail page they're
  // showing (and the contact panel scopes by contact_id).
  sequence_enrollment: ['sequence_id', 'contact_id'],
}

// Equality over realtime payload values — plain decoded JSON, so strict
// equality covers primitives and a stringify comparison covers json/jsonb
// columns (old and new come through the same wal2json encoding, so equal
// values serialize identically).
function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Diff an UPDATE's new row against its old row, keeping only the columns
 *  that actually changed — plus workspace_id and the table's scope columns
 *  (always forwarded; see SCOPE_COLUMNS). The old row SHOULD be complete
 *  (REPLICA IDENTITY FULL, migration 187), but be defensive: a column
 *  missing from `old` counts as CHANGED, degrading to over-forwarding
 *  (the historical full-row behavior) rather than a dropped change. `id`
 *  stays excluded — it's carried separately on the event. */
function changedFields(
  table: string,
  newRow: RealtimeRow,
  oldRow: RealtimeRow | null | undefined,
): Record<string, unknown> {
  const scopeCols = SCOPE_COLUMNS[table]
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(newRow)) {
    if (key === 'id') continue
    if (key === 'workspace_id' || scopeCols?.includes(key)) {
      fields[key] = newRow[key]
      continue
    }
    if (!oldRow || !(key in oldRow)) {
      fields[key] = newRow[key]
      continue
    }
    if (!jsonValueEqual(oldRow[key], newRow[key])) fields[key] = newRow[key]
  }
  return fields
}

// Bumped on every channel bind so each one gets its own topic. realtime-js
// hands back the EXISTING channel for a repeated topic, and an un-acked leave
// keeps the old one registered (state `leaving`) — on which `.subscribe()` is a
// silent no-op. A rebind on the same topic (the cross-workspace flip below runs
// cleanup and the new bind in one commit) would attach every binding to the
// dying channel and leave entity realtime silent until a reload.
let channelSeq = 0

export function useRealtimeEntities(workspaceId: string | null | undefined) {
  // Re-render (and so re-run the effect below, tearing the channel down and
  // re-subscribing it) whenever a table's cross-workspace hold flips on or off:
  // a postgres_changes filter is fixed at bind time, so the binding can only
  // change by rebinding. SSR snapshot is '' (nothing widened) — no channel is
  // subscribed there anyway.
  //
  // The rebind leaves a sub-second window with no subscription, which needs no
  // catch-up fan-out: the only thing that flips a hold is a list changing its
  // workspace scope, and that change re-queries the list from scratch.
  const crossWorkspaceTables = useSyncExternalStore(
    subscribeCrossWorkspace,
    crossWorkspaceTablesKey,
    () => '',
  )

  useEffect(() => {
    if (!workspaceId) return

    const supabase = createClient()
    // One channel covers every table. Supabase multiplexes multiple
    // postgres_changes bindings over a single websocket.
    const channel = supabase.channel(`workspace-entities:${workspaceId}:${++channelSeq}`)

    for (const { table, entityType, filtered } of TABLES) {
      // Does THIS table bind to the active workspace? Tables without a
      // workspace_id column never can (see the TABLES doc comment), and
      // `actions` / `projects` give their filter up while a list is showing
      // every workspace (see the cross-workspace block above).
      const unfiltered = filtered === false || isWidenedIn(crossWorkspaceTables, table)
      // One wildcard binding per table (instead of 3 per-event bindings)
      // keeps the total binding count manageable as the table list grows.
      // Tables without a workspace_id column subscribe unfiltered and rely
      // on RLS for INSERT/UPDATE scoping (see TABLES doc comment).
      channel.on(

        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table,
          ...(unfiltered ? {} : { filter: `workspace_id=eq.${workspaceId}` }),
        },
        (payload: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: RealtimeRow; old: RealtimeRow }) => {
          if (payload.eventType === 'INSERT') {
            // Silently refresh any list that would include this row.
            const row = payload.new
            const id = eventId(table, row ?? {})
            if (!id) return
            // Drop self-echo: if this tab just created the entity, the local
            // emit already updated UIs; the realtime fan-out would only cause
            // redundant work.
            if (wasRecentlyMutatedLocally(entityType, id)) return
            emitEntityCreated({ entityType, id }, { skipBroadcast: true })
          } else if (payload.eventType === 'UPDATE') {
            // Patch the cached row in place using ONLY the columns that
            // actually changed (diffed against the REPLICA IDENTITY FULL old
            // row — see changedFields, which also always keeps the scoping
            // columns listeners match on, e.g. comment.commentable_id,
            // flow_run.flow_id). Forwarding the whole row would defeat
            // downstream "did field X change?" presence checks — every
            // UPDATE (each transcript append included) would read as a
            // joined-FK change in unified-view-layout and force a full list
            // refetch instead of the O(1) patch, and its board column-move
            // fast path could never run.
            const row = payload.new
            const id = eventId(table, row ?? {})
            if (!id) return
            // Drop self-echo: prevents the realtime UPDATE from clobbering
            // any in-flight local edit (e.g. user typing a different field
            // on the same row right after triggering a status change).
            if (wasRecentlyMutatedLocally(entityType, id)) return
            const fields = changedFields(table, row ?? {}, payload.old)
            emitEntityUpdated({ entityType, id, fields }, { skipBroadcast: true })
          } else if (payload.eventType === 'DELETE') {
            // Remove from any cached list. REPLICA IDENTITY FULL (migration
            // 187) means `old` carries the full row — required for the
            // workspace_id filter to match DELETEs at all.
            const row = payload.old
            const id = eventId(table, row ?? {})
            if (!id) return
            if (wasRecentlyMutatedLocally(entityType, id)) return
            const { id: _oldId, ...fields } = row
            void _oldId
            emitEntityDeleted({ entityType, id, fields }, { skipBroadcast: true })
          }
        },
      )
    }

    // Track subscription state. On a successful (re)subscribe after a prior
    // failure, fire a synthetic `dial8:realtime-recovered` window event so
    // mounted lists can refetch — they'll have missed any events during the
    // gap. First-time subscribes don't fire it (nothing was missed).
    //
    // Jitter the dispatch by 0-2s so a fleet-wide reconnect (e.g. after a
    // deploy) doesn't stampede the API. A 50-user team × 5 mounted lists ×
    // simultaneous reconnect would otherwise hit the views/query endpoint
    // with 250 concurrent requests on cold lambdas.
    //
    // The event carries the watchdog's repair id (realtime-recovery.ts) so
    // listeners can correlate a fan-out with the repair that caused it. The id
    // is informational only — it never gates the dispatch: this channel can be
    // dropped and re-subscribed by Supabase alone, with no watchdog pass
    // involved, and that gap still has to be caught up.
    let hadFailure = false
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' && hadFailure) {
        hadFailure = false
        setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent('dial8:realtime-recovered', {
                detail: { repairId: getLastRepairId() },
              }),
            ),
          Math.random() * 2000,
        )
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        hadFailure = true
      }
    })

    // Proactively force a realtime reconnect when the app wakes from sleep or
    // regains network. After a macOS sleep (notably in the desktop app's
    // WebView) the websocket is silently dead, but the Supabase client can take
    // a while to notice via its heartbeat — leaving the UI stale and then
    // "catching up" all at once. Reconnecting on wake makes recovery near-instant.
    //
    // We DELEGATE the socket+channel repair to the shared watchdog routine
    // (realtime-recovery.ts / requestRecovery) rather than hand-rolling
    // getSession→setAuth→connect here: that centralizes the recovery semantics
    // (getSession → setAuth → knock stale channels → connect) so this path can't
    // drift from the watchdog's — in particular it inherits the zombie-channel
    // knock, which a bare connect() here would miss (a channel that stayed
    // `joined` through a swallowed close has no rejoinTimer and would go deaf on
    // the fresh socket). requestRecovery shares the watchdog's debounce/throttle,
    // so overlapping wake signals collapse into one pass.
    //
    // We still set `hadFailure = true` locally so THIS channel's next SUBSCRIBED
    // (fired when the knock's rejoin re-subscribes it) emits
    // `dial8:realtime-recovered`, driving mounted lists to refetch what they
    // missed during the gap — but ONLY when a repair actually happened.
    //
    // Latching unconditionally (the old behaviour) armed the flag on every ≥30s
    // visibility return and every `online`, even when requestRecovery() no-opped
    // on a perfectly healthy socket. The flag is sticky, so the channel's NEXT
    // re-subscribe for ANY unrelated reason (a Supabase heartbeat hiccup, a WS
    // proxy blip) then fired the app-wide fan-out — which is how a healthy
    // return produced a spontaneous 21-request storm ~2 min later. requestRecovery
    // now resolves true only after a pass genuinely repaired a dead socket, so a
    // healthy wake is a true end-to-end no-op.
    const forceReconnect = () => {
      void requestRecovery().then((repaired) => {
        if (repaired) hadFailure = true
      })
    }
    // Only treat a wake as suspect if the tab was hidden long enough for the
    // OS/WebView to have plausibly killed the socket. Quick tab flips (<30s)
    // don't tear the connection down — doing so on every flip would cause a
    // disconnect/reconnect/refetch storm for users who alt-tab frequently.
    const HIDDEN_SUSPECT_MS = 30_000
    let hiddenAt: number | null = null
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0
      hiddenAt = null
      if (hiddenFor >= HIDDEN_SUSPECT_MS) forceReconnect()
    }
    window.addEventListener('online', forceReconnect)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.removeEventListener('online', forceReconnect)
      document.removeEventListener('visibilitychange', onVisible)
      supabase.removeChannel(channel)
    }
  }, [workspaceId, crossWorkspaceTables])
}
