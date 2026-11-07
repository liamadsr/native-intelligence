import { randomUUID } from 'node:crypto'
import type { getServiceClient } from '@/lib/admin'

// ──────────────────────────────────────────────────────────────────
// Reminder pass — fire due per-user "remind me" reminders.
//
// A reminder is a row in public.reminder with delivered_at IS NULL and a
// remind_at that has arrived. Firing it means inserting ONE notification row
// (type 'reminder') for the owner's member — the existing realtime path then
// carries it to the inbox, the toast, and the Tauri native banner for free.
//
// Why the notification is inserted DIRECTLY rather than via createNotification:
//   • createNotification DROPS any notification whose actorId === recipientId.
//     A reminder is the codebase's only self-notification, so it would have to
//     omit the actor anyway — but more importantly,
//   • it SWALLOWS insert errors (console.error only). We need the error to roll
//     delivered_at back so the next tick retries; a swallowed error would burn
//     the reminder silently (exactly the failure mode migration 172 documents).
//   • it also has a 5-minute type+target dedupe that would collapse a reminder
//     set twice on the same entity minutes apart.
//
// The claim is a CAS on delivered_at (`WHERE delivered_at IS NULL`), the same
// double-fire guard as the schedule pass's next_run_at CAS: overlapping ticks
// can both see a due row, only one can claim it.
//
// EVERYTHING the notification is built from is re-derived here, at fire time,
// under the reminder's own workspace_id — the title, the visibility rule, and
// the recipient member. This pass runs on the SERVICE client, so it is the one
// place in the reminder path with no RLS beneath it; it cannot inherit trust
// from the set-time checks in /api/account/reminders, which ran minutes-to-
// months earlier against state that has since moved on (entity deleted or
// moved, capture flipped to private, owner left the workspace). Anything that
// no longer resolves is a SILENT CANCEL, never a delivered notification.
// ──────────────────────────────────────────────────────────────────

/** Per-tick cap, matching the schedule pass's due-scan bound. */
const REMINDER_SCAN_LIMIT = 200

/** Entity table + title column per reminder entity_type. Mirrors the account
 *  detail routes (actions/[id], projects/[id], initiatives/[id], captures/[id],
 *  documents/[id]) — note the singular/plural split is real, not a typo. */
const REMINDER_ENTITY_SOURCES: Record<string, { table: string; titleColumn: string }> = {
  action: { table: 'actions', titleColumn: 'title' },
  project: { table: 'projects', titleColumn: 'name' },
  initiative: { table: 'initiative', titleColumn: 'name' },
  capture: { table: 'captures', titleColumn: 'title' },
  document: { table: 'document', titleColumn: 'title' },
}

/** A due reminder row as scanned by the pass. Exported for the pass tests. */
export interface DueReminderRow {
  id: string
  workspace_id: string
  user_id: string
  entity_type: string
  entity_id: string
  remind_at: string
}

/**
 * Map key for a title resolved per (entity_type, workspace_id, entity_id) — and,
 * for visibility-restricted entities, per owning user as well.
 *
 * The workspace is part of the key, not just a filter: two workspaces can hold
 * the same uuid only by accident, but keying without it would let a row read for
 * workspace A satisfy a reminder stamped workspace B.
 *
 * `userId` is set ONLY for entities whose title visibility depends on the
 * reminder owner (private captures). Without it, one owner's resolved title
 * would sit under a shared key that a co-tenant's reminder on the same entity
 * would then read — leaking a private capture's title into another member's
 * notification body. A user-scoped key means each owner can only ever read the
 * title that was resolved against THEIR own visibility.
 */
function reminderEntityKey(
  entityType: string,
  workspaceId: string,
  entityId: string,
  userId?: string,
): string {
  return userId === undefined
    ? `${entityType}:${workspaceId}:${entityId}`
    : `${entityType}:${workspaceId}:${entityId}:${userId}`
}

/** Map key for a (user, workspace) → member.id resolution. */
function reminderMemberKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`
}

export async function runReminderPass(
  supabase: ReturnType<typeof getServiceClient>,
  now: Date,
): Promise<{ due: number; fired: number; cancelled: number; lost: number; errored: number }> {
  const nowIso = now.toISOString()

  const { data: due, error } = await supabase
    .from('reminder')
    .select('id, workspace_id, user_id, entity_type, entity_id, remind_at')
    .is('delivered_at', null)
    .lte('remind_at', nowIso)
    .order('remind_at', { ascending: true })
    .limit(REMINDER_SCAN_LIMIT)

  if (error) {
    console.error('[flow-schedule cron] reminder due-scan failed:', error.message)
    return { due: 0, fired: 0, cancelled: 0, lost: 0, errored: 1 }
  }

  const rows = (due ?? []) as DueReminderRow[]
  if (rows.length === 0) {
    return { due: 0, fired: 0, cancelled: 0, lost: 0, errored: 0 }
  }

  // Titles are read FRESH at fire time (the entity may have been renamed since
  // the reminder was set) — batched per (entity_type, workspace_id) so a 200-row
  // tick costs a handful of reads, not 200.
  const { titles, failedTypes } = await fetchReminderEntityTitles(supabase, rows)
  // The notification recipient. Resolved here, never stored on the reminder — a
  // stored recipient column is client-writable and would let one member address
  // another's inbox. See migration 224's header.
  const { members, failedMemberLookup } = await fetchReminderRecipients(supabase, rows)

  let fired = 0
  let cancelled = 0
  let lost = 0
  let errored = 0

  for (const reminder of rows) {
    try {
      // CAS-claim: only the tick that flips delivered_at from NULL owns the fire.
      // Also CAS on the remind_at the scan saw: a reminder rescheduled since
      // (snoozed into the future) loses the claim instead of firing at its old
      // time and burning the new one; if it is still due, the next tick fires it.
      const { data: claimed, error: claimError } = await supabase
        .from('reminder')
        .update({ delivered_at: nowIso })
        .eq('id', reminder.id)
        .is('delivered_at', null)
        .eq('remind_at', reminder.remind_at)
        .select('id')

      if (claimError) {
        errored += 1
        console.error(
          `[flow-schedule cron] reminder claim failed for ${reminder.id}:`,
          claimError.message,
        )
        continue
      }
      if (!claimed || claimed.length === 0) {
        // Another overlapping tick already claimed (or the user cleared it).
        lost += 1
        continue
      }

      // A lookup that failed outright — we cannot tell "gone" from "database
      // hiccup", so we must not cancel. Roll the claim back and let the next tick
      // re-read. Only a SUCCESSFUL query that came back without the row proves
      // the entity (or the membership) is really gone.
      const typeKey = `${reminder.entity_type}:${reminder.workspace_id}`
      if (failedTypes.has(typeKey) || failedMemberLookup) {
        errored += 1
        console.error(
          `[flow-schedule cron] reminder ${reminder.id} deferred: a fire-time lookup failed this tick, rolling delivered_at back`,
        )
        await rollbackReminderClaim(supabase, reminder.id, nowIso)
        continue
      }

      // Entity gone — or no longer visible to the owner — since the reminder was
      // set: silently cancel. delivered_at stays set so it is never rescanned;
      // nothing is inserted (a reminder for a deleted action is noise, not
      // information, and a reminder for a capture whose owner has since flipped
      // it to private must not leak its title).
      //
      // Private-capture titles live under a user-scoped key readable only by the
      // creator; everything else lives under the shared key. Try the caller's
      // user-scoped key first, then the shared one — a co-tenant reminder on a
      // private capture matches neither and is correctly cancelled.
      const title =
        titles.get(
          reminderEntityKey(
            reminder.entity_type,
            reminder.workspace_id,
            reminder.entity_id,
            reminder.user_id,
          ),
        ) ??
        titles.get(
          reminderEntityKey(reminder.entity_type, reminder.workspace_id, reminder.entity_id),
        )
      if (title === undefined) {
        cancelled += 1
        continue
      }

      // The recipient is the owner's member row IN THIS REMINDER'S WORKSPACE. No
      // such row means the user left the workspace between setting and firing —
      // there is no inbox to deliver to, so cancel exactly like a gone entity.
      const recipientId = members.get(
        reminderMemberKey(reminder.user_id, reminder.workspace_id),
      )
      if (recipientId === undefined) {
        cancelled += 1
        continue
      }

      // The id is minted here so the agent's event (below) can key on it.
      const notificationId = randomUUID()
      const { error: insertError } = await supabase.from('notification').insert({
        id: notificationId,
        workspace_id: reminder.workspace_id,
        // recipient_id is member.id, not user_id (see 031_notifications.sql).
        recipient_id: recipientId,
        type: 'reminder',
        title: 'Reminder',
        body: title,
        // NO actor_id — a reminder is self-sent; an actor equal to the recipient
        // renders a pointless avatar (and is the value createNotification drops on).
        actor_id: null,
        target_type: reminder.entity_type,
        target_id: reminder.entity_id,
        group_key: `reminder:${reminder.id}`,
        metadata: { reminder_id: reminder.id, remind_at: reminder.remind_at },
      })

      if (insertError) {
        // Roll the claim back so the next tick retries — mirrors emitDueAfterCas.
        errored += 1
        console.error(
          `[flow-schedule cron] reminder notification insert failed for ${reminder.id}, rolling delivered_at back:`,
          insertError.message,
        )
        await rollbackReminderClaim(supabase, reminder.id, nowIso)
        continue
      }

      // The agent hears it too (agent-events/notice.ts): one event for the
      // owner, titled with what the reminder is about. Never throws.
      await import('@/lib/agent-events/notice')
        .then((m) =>
          m.recordNoticeEvent(
            {
              notificationId,
              workspaceId: reminder.workspace_id,
              recipientMemberId: recipientId,
              type: 'reminder',
              title,
              targetType: reminder.entity_type,
              targetId: reminder.entity_id,
            },
            supabase,
          ),
        )
        .catch(() => 0)

      fired += 1
    } catch (err) {
      // One corrupt row must not stall the rest of the tick (schedule-pass rule).
      errored += 1
      console.error(
        `[flow-schedule cron] reminder fire failed for ${reminder.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { due: rows.length, fired, cancelled, lost, errored }
}

/**
 * Release a claim this tick took, so the reminder is rescanned next tick.
 * Guarded on OUR delivered_at value so a concurrent write is never clobbered.
 */
async function rollbackReminderClaim(
  supabase: ReturnType<typeof getServiceClient>,
  reminderId: string,
  claimedAtIso: string,
): Promise<void> {
  const { error } = await supabase
    .from('reminder')
    .update({ delivered_at: null })
    .eq('id', reminderId)
    .eq('delivered_at', claimedAtIso)
  if (error) {
    console.error(
      `[flow-schedule cron] reminder rollback failed for ${reminderId}; it will not re-fire:`,
      error.message,
    )
  }
}

/**
 * Batch-load the CURRENT title of every reminded entity, one query per
 * (entity_type, workspace_id). Keyed `<entity_type>:<workspace_id>:<entity_id>`;
 * an absent key for a group that queried SUCCESSFULLY means the entity no longer
 * exists — or never belonged to that workspace — → the caller cancels.
 *
 * WHY the workspace is on the query and not just the key: this runs on the
 * service client, so RLS is off and an `.in('id', …)` alone reads across every
 * tenant. The entity→workspace binding is checked once, by the POST route's
 * existence probe; the cron must not depend on that check still holding, so it
 * re-asserts it here. Captures additionally re-apply the visibility predicate —
 * a capture flipped to 'private' after the reminder was set must not have its
 * title read back out through a notification body (migration 223's whole point).
 *
 * A group whose read ERRORED is reported in `failedTypes` (keyed
 * `<entity_type>:<workspace_id>`) instead: a transient DB failure looks identical
 * to "entity gone" in the map alone, and cancelling on it would destroy a live
 * reminder permanently. The caller rolls those claims back and retries next tick.
 */
async function fetchReminderEntityTitles(
  supabase: ReturnType<typeof getServiceClient>,
  rows: DueReminderRow[],
): Promise<{ titles: Map<string, string>; failedTypes: Set<string> }> {
  const titles = new Map<string, string>()
  const failedTypes = new Set<string>()
  // (entity_type, workspace_id) → ids. Grouping by type ALONE would drop the
  // workspace filter for every row after the first.
  const groups = new Map<
    string,
    { entityType: string; workspaceId: string; ids: Set<string> }
  >()
  for (const row of rows) {
    if (!REMINDER_ENTITY_SOURCES[row.entity_type]) continue
    const key = `${row.entity_type}:${row.workspace_id}`
    const group = groups.get(key) ?? {
      entityType: row.entity_type,
      workspaceId: row.workspace_id,
      ids: new Set<string>(),
    }
    group.ids.add(row.entity_id)
    groups.set(key, group)
  }

  for (const [key, { entityType, workspaceId, ids }] of groups) {
    const source = REMINDER_ENTITY_SOURCES[entityType]
    // Captures carry the owner columns so the visibility rule can be re-applied
    // per reminder below — one capture row can serve reminders owned by
    // different users, so the filtering cannot be pushed into the query.
    const columns =
      entityType === 'capture'
        ? `id, ${source.titleColumn}, visibility, user_id`
        : `id, ${source.titleColumn}`
    const { data, error } = await supabase
      .from(source.table)
      .select(columns)
      .eq('workspace_id', workspaceId)
      .in('id', [...ids])
    if (error) {
      failedTypes.add(key)
      console.error(
        `[flow-schedule cron] reminder title lookup failed for ${entityType}:`,
        error.message,
      )
      continue
    }
    // Owners of the reminders in this group, so a private capture can be
    // resolved for its creator and hidden from everyone else.
    const ownersByEntity = new Map<string, Set<string>>()
    if (entityType === 'capture') {
      for (const row of rows) {
        if (row.entity_type !== entityType || row.workspace_id !== workspaceId) continue
        const owners = ownersByEntity.get(row.entity_id) ?? new Set<string>()
        owners.add(row.user_id)
        ownersByEntity.set(row.entity_id, owners)
      }
    }

    for (const entity of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const entityId = entity.id as string
      const title = entity[source.titleColumn]
      const resolved =
        typeof title === 'string' && title.trim().length > 0 ? title : 'Untitled'

      if (entityType === 'capture' && entity.visibility === 'private') {
        // Private: the title is only ever resolvable by the capture's own
        // creator. Store it under a key scoped to that user so no OTHER
        // co-tenant reminder on the same capture can read it (the shared key
        // would leak the private title into their notification body). If the
        // creator isn't among this group's reminder owners, store nothing —
        // every reader then misses and the caller silently cancels.
        const creatorId = entity.user_id as string
        if (ownersByEntity.get(entityId)?.has(creatorId)) {
          titles.set(reminderEntityKey(entityType, workspaceId, entityId, creatorId), resolved)
        }
        continue
      }
      titles.set(reminderEntityKey(entityType, workspaceId, entityId), resolved)
    }
  }

  return { titles, failedTypes }
}

/**
 * Resolve each reminder's notification recipient: the owner's member row in the
 * reminder's OWN workspace, keyed `<user_id>:<workspace_id>`.
 *
 * This join is the whole reason `reminder` has no member_id column — see
 * migration 224's header. A user has one member row PER workspace, so
 * (user_id, workspace_id) is the only pair that identifies the right inbox, and
 * deriving it here at fire time means no client-writable column can redirect it.
 *
 * A missing pair means the user is no longer a member of that workspace: there
 * is no inbox, so the caller cancels. `failedMemberLookup` distinguishes that
 * from a transient read failure, which must roll the claim back instead —
 * cancelling on a hiccup would burn every due reminder in the tick.
 */
async function fetchReminderRecipients(
  supabase: ReturnType<typeof getServiceClient>,
  rows: DueReminderRow[],
): Promise<{ members: Map<string, string>; failedMemberLookup: boolean }> {
  const members = new Map<string, string>()
  const userIds = [...new Set(rows.map((r) => r.user_id))]
  const workspaceIds = [...new Set(rows.map((r) => r.workspace_id))]

  // Cross-product read, filtered back down by exact pair below: PostgREST cannot
  // express a tuple IN, and the pass is capped at 200 rows so both lists are small.
  const { data, error } = await supabase
    .from('member')
    .select('id, user_id, workspace_id')
    .in('user_id', userIds)
    .in('workspace_id', workspaceIds)

  if (error) {
    console.error('[flow-schedule cron] reminder recipient lookup failed:', error.message)
    return { members, failedMemberLookup: true }
  }

  const wanted = new Set(rows.map((r) => reminderMemberKey(r.user_id, r.workspace_id)))
  for (const row of (data ?? []) as Array<{
    id: string
    user_id: string
    workspace_id: string
  }>) {
    const key = reminderMemberKey(row.user_id, row.workspace_id)
    if (wanted.has(key)) members.set(key, row.id)
  }

  return { members, failedMemberLookup: false }
}

