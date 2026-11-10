/**
 * Entity mutation event bus.
 *
 * When *any* code path mutates an entity (detail panel, inline cell edit,
 * bulk action, AI tool call, etc.), it should emit one of these events so
 * every other UI surface that's caching that entity can update or invalidate
 * its copy. Without this, you get stale-data bugs: edit status in the side
 * panel, navigate back to the list, see the old status.
 *
 * Three events:
 *   - ni:entity-created  (already in use)
 *   - ni:entity-updated  (new — emit after PATCH)
 *   - ni:entity-deleted  (new — emit after DELETE)
 *
 * Listeners can patch their cached row in place using the `fields` payload,
 * avoiding a server round-trip.
 */

/**
 * Entity kinds that flow through the event bus.
 *
 * Every kind below has all three legs — in-tab (window CustomEvent),
 * cross-tab (BroadcastChannel), and teammate/server (Supabase Realtime via
 * use-realtime-entities.ts, which re-emits postgres_changes onto this bus) —
 * with one exception:
 *
 *   email_thread — Realtime is handled bespoke in email-layout.tsx (its own
 *   channel on email_thread_index with provider-id matching), NOT through
 *   use-realtime-entities.ts. In-tab/cross-tab emits still work normally.
 *
 * The kinds come from the entity registry (src/lib/knowledge/entity-registry.ts):
 * add a kind there, never here. Its `realtime` flag decides whether
 * use-realtime-entities.ts streams the kind's table; migration
 * 187_realtime_sync_coverage.sql is the authoritative publication list. A
 * kind without a realtime source only updates the emitting browser, never
 * teammates or MCP/cron writes.
 *
 * Two kinds are not registry entries:
 *   entity_link  — an edge between entities, not an entity.
 *   email_thread — the UI's name for the registry's `email` kind (same
 *                  email_thread_index row). `email` is the stored graph value
 *                  (entity_link / claim rows), so unifying the two names needs
 *                  a data migration.
 */
export type EntityKind = EntityType | 'entity_link' | 'email_thread'

export interface EntityUpdatedDetail {
  entityType: EntityKind
  id: string
  /** The patched fields, used by listeners to update in place. */
  fields: Record<string, unknown>
}

export interface EntityDeletedDetail {
  entityType: EntityKind
  id: string
  /** The deleted row's last column values, when known (realtime DELETEs carry
   *  them via REPLICA IDENTITY FULL). Lets scoped listeners match without a
   *  lookup (e.g. a comments list checking fields.commentable_id). May be
   *  absent for locally-emitted deletes. */
  fields?: Record<string, unknown>
}

export interface EntityCreatedDetail {
  entityType: EntityKind
  /** Optional id if the caller knows it. */
  id?: string
}

// ── Cross-tab bridge ─────────────────────────────────────────
// BroadcastChannel mirrors each in-tab event to every other tab on the same
// origin. Other tabs re-dispatch the CustomEvent locally so their existing
// window listeners light up without any call-site changes.
//
// Each tab stamps its own events with a session-unique source id and ignores
// its own echoes — without this, a tab would receive duplicates.
//
// Workspace scoping: the channel itself is shared across the whole origin,
// but every envelope carries the originating workspace id. Receivers drop
// envelopes whose `ws` doesn't match their CURRENT active workspace — so a
// tab on Workspace A doesn't react to mutations broadcast from a tab on
// Workspace B (which would otherwise invalidate B's picker caches and flash
// stale data). Envelopes with `ws = null` are treated as legacy / workspace-
// agnostic and always delivered, which keeps things working during very
// early app boot before the workspace context has been set.

import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import type { EntityType } from '@/lib/knowledge/entity-registry'

const BROADCAST_CHANNEL_NAME = 'ni:entity-events'
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

type BroadcastEnvelope =
  | { kind: 'updated'; src: string; ws: string | null; detail: EntityUpdatedDetail }
  | { kind: 'deleted'; src: string; ws: string | null; detail: EntityDeletedDetail }
  | { kind: 'created'; src: string; ws: string | null; detail: EntityCreatedDetail }

// Subscribe immediately on module load. A tab that only listens (never emits)
// still needs onmessage wired up; deferring to the first emit would mean a
// receive-only tab never gets cross-tab events.
//
// Guarded for SSR — the module loads server-side too, where window and
// BroadcastChannel are undefined.
//
// Lifecycle: in production this channel lives for the page's lifetime; the
// browser cleans it up on tab close. In Next.js dev with HMR, fast-refresh
// can re-execute this module without disposing the prior instance, leaving
// stale onmessage handlers attached. There's no clean hook for cleanup in
// Next.js (no import.meta.hot.dispose), so we accept duplicate dispatches
// during dev sessions — they're idempotent in our listeners (updateItem
// with the same fields is a no-op visually). Prod is unaffected.
let channel: BroadcastChannel | null = null

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
  channel.onmessage = (e: MessageEvent<BroadcastEnvelope>) => {
    const env = e.data
    if (!env || env.src === TAB_ID) return
    // Workspace filter — drop envelopes from a different active workspace.
    // `ws == null` envelopes are legacy/agnostic and always delivered.
    const myWs = getClientWorkspaceId()
    if (env.ws && myWs && env.ws !== myWs) return
    const eventName =
      env.kind === 'updated' ? 'ni:entity-updated'
      : env.kind === 'deleted' ? 'ni:entity-deleted'
      : 'ni:entity-created'
    window.dispatchEvent(new CustomEvent(eventName, { detail: env.detail }))
  }
}

function broadcast(envelope: BroadcastEnvelope) {
  try { channel?.postMessage(envelope) } catch { /* ignore — other tabs miss out */ }
}

/** Options for emit functions. `skipBroadcast` is for realtime-originated
 *  events: every tab already gets its own copy from the realtime fan-out,
 *  so re-broadcasting would just cause duplicate dispatches.
 *
 *  `skipSelfMark` is for emits that announce something NO row write produced —
 *  the external_links republish after a push is the case it exists for. The
 *  self-echo window below suppresses the realtime echo of THIS tab's own write
 *  to the entity's row; when there was no such write, no echo is ever coming and
 *  the only events the window can swallow are OTHER users' changes to that
 *  entity for the next 10 seconds. Pass this to keep both dispatch legs (the
 *  in-tab CustomEvent and the cross-tab mirror) without arming it. */
interface EmitOptions { skipBroadcast?: boolean; skipSelfMark?: boolean }

// ── Self-echo suppression ────────────────────────────────────
// Supabase Realtime fans an UPDATE out to EVERY subscribed tab, including
// the tab that did the write. When the dragging tab receives its own echo
// it would re-apply server state on top of any in-flight local edits (e.g.
// the user already started typing into another field). To avoid that, we
// stamp each emit with `(entityType, id)` and the realtime listener checks
// `wasRecentlyMutatedLocally` to skip its own echoes.
//
// 10s window covers PATCH → Postgres LISTEN → realtime fan-out under load:
// Supabase Realtime p99 is regularly 2-5s, plus PATCH latency on busy serverless
// cold starts can add another 1s. A shorter window risks expiring before the
// echo arrives, which defeats the suppression. Memory cost is trivial (Map
// entries are tiny).
// Map cleared lazily on read so we don't need a timer.
const RECENT_MUTATION_TTL_MS = 10000
const recentLocalMutations = new Map<string, number>()  // `${kind}:${id}` → expiresAt

/** Arm the self-echo window for `(entityType, id)` WITHOUT emitting an event.
 *  The emit functions arm it automatically on every local emit; this export is
 *  for writers that persist a row silently — the recording transcript saver
 *  PATCHes/POSTs the capture row every ~2–30s with no matching emit, so without
 *  arming, the recorder refetches its own realtime echo (a full-transcript GET
 *  per append). Tradeoff (same as any local emit): while armed, OTHER users'
 *  realtime updates to the same row are also dropped — call this only when
 *  another live surface (e.g. the capture panel's bespoke capture-stream
 *  channel) or a poll fallback covers catch-up. */
export function markLocallyMutated(entityType: EntityKind, id: string) {
  recentLocalMutations.set(`${entityType}:${id}`, Date.now() + RECENT_MUTATION_TTL_MS)
}

/** Returns true if THIS tab emitted a mutation for the given entity within
 *  the recent-mutation window. Used by realtime subscribers to drop their
 *  own echoes. Called per realtime event; cheap O(1) map lookup. */
export function wasRecentlyMutatedLocally(entityType: EntityKind, id: string): boolean {
  const key = `${entityType}:${id}`
  const expiresAt = recentLocalMutations.get(key)
  if (!expiresAt) return false
  if (Date.now() > expiresAt) {
    recentLocalMutations.delete(key)
    return false
  }
  return true
}

export function emitEntityUpdated(detail: EntityUpdatedDetail, opts?: EmitOptions) {
  if (typeof window === 'undefined') return
  if (!opts?.skipBroadcast && !opts?.skipSelfMark) markLocallyMutated(detail.entityType, detail.id)
  window.dispatchEvent(new CustomEvent('ni:entity-updated', { detail }))
  if (!opts?.skipBroadcast) broadcast({ kind: 'updated', src: TAB_ID, ws: getClientWorkspaceId(), detail })
}

export function emitEntityDeleted(detail: EntityDeletedDetail, opts?: EmitOptions) {
  if (typeof window === 'undefined') return
  if (!opts?.skipBroadcast) markLocallyMutated(detail.entityType, detail.id)
  window.dispatchEvent(new CustomEvent('ni:entity-deleted', { detail }))
  if (!opts?.skipBroadcast) broadcast({ kind: 'deleted', src: TAB_ID, ws: getClientWorkspaceId(), detail })
}

export function emitEntityCreated(detail: EntityCreatedDetail, opts?: EmitOptions) {
  if (typeof window === 'undefined') return
  if (!opts?.skipBroadcast && detail.id) markLocallyMutated(detail.entityType, detail.id)
  window.dispatchEvent(new CustomEvent('ni:entity-created', { detail }))
  if (!opts?.skipBroadcast) broadcast({ kind: 'created', src: TAB_ID, ws: getClientWorkspaceId(), detail })
}

// ── Listener helpers (typed) ─────────────────────────────────

export function onEntityUpdated(handler: (detail: EntityUpdatedDetail) => void) {
  if (typeof window === 'undefined') return () => {}
  const wrapped = (e: Event) => handler((e as CustomEvent).detail as EntityUpdatedDetail)
  window.addEventListener('ni:entity-updated', wrapped)
  return () => window.removeEventListener('ni:entity-updated', wrapped)
}

export function onEntityDeleted(handler: (detail: EntityDeletedDetail) => void) {
  if (typeof window === 'undefined') return () => {}
  const wrapped = (e: Event) => handler((e as CustomEvent).detail as EntityDeletedDetail)
  window.addEventListener('ni:entity-deleted', wrapped)
  return () => window.removeEventListener('ni:entity-deleted', wrapped)
}
