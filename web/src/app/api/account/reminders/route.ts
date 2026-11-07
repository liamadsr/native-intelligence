/**
 * Per-user reminders on entities (Linear's "Remind me").
 *
 * A reminder is PRIVATE to the caller: the `reminder` table's RLS is owner-only
 * (`auth.uid() = user_id`), so every query here runs on the RLS client and is
 * already scoped to the caller — the explicit `.eq('user_id', user.id)` filters
 * below are defence-in-depth, not the security boundary.
 *
 * Exactly ONE pending reminder may exist per (user, entity) — enforced by the
 * partial unique index `reminder_pending_unique_idx` (migration 224) on
 * (user_id, entity_type, entity_id) WHERE delivered_at IS NULL. Setting a
 * reminder on an entity that already has one therefore RESCHEDULES it (update
 * remind_at) rather than stacking a second row. Delivered rows keep
 * accumulating as history and are outside the unique index.
 *
 * IDENTITY: (user_id, entity_type, entity_id) — the unique index's key, and the
 * key ALL THREE VERBS use. workspace_id is deliberately NOT part of it. Entities
 * move between workspaces in place, keeping their uuid (migration 221's move
 * engine), so a workspace-scoped identity would strand the pre-move row:
 * invisible to GET, unclearable by DELETE, and un-replaceable by POST because
 * the workspace-free unique index still blocks a second pending row. Instead
 * workspace_id is treated as a mutable STAMP that every write refreshes from the
 * current request, so a moved entity's reminder re-homes on the next reschedule.
 *
 * Firing happens out of band: the 5-min flow-schedule cron sweeps due rows,
 * CAS-claims them via delivered_at, and inserts a `reminder` notification. The
 * notification's recipient member is resolved THERE, from (user_id,
 * workspace_id) — this table stores no recipient column, because an owner-only
 * UPDATE policy cannot stop a client from pointing one at someone else's inbox.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import { REMINDER_ENTITY_TYPES, type ReminderEntityType } from '@/lib/reminders/types'
import { NextResponse, type NextRequest } from 'next/server'

const REMINDER_FIELDS =
  'id, workspace_id, user_id, entity_type, entity_id, remind_at, delivered_at, created_at, updated_at'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where each reminder-able entity lives. The table names are NOT uniformly
 * plural — `actions`/`projects`/`captures` are plural while `initiative` and
 * `document` are singular — so they're pinned here against the account detail
 * routes (`/api/account/{actions,projects,initiatives,captures,documents}/[id]`)
 * rather than derived from the entity_type string.
 */
const ENTITY_TABLES: Record<ReminderEntityType, string> = {
  action: 'actions',
  project: 'projects',
  initiative: 'initiative',
  capture: 'captures',
  document: 'document',
}

/**
 * A reminder may not outlive plausible intent: anything past this is far more
 * likely a client bug (ms-vs-seconds, a parsed year of 20226) than a user who
 * genuinely wants a ping in 2050.
 */
const MAX_REMIND_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000

/**
 * Tolerance for a "now"-ish reminder: request latency and client/server clock
 * skew mean a picker's `now + 5 min` can land marginally in the past by the
 * time it's validated. The cron fires those on its next tick.
 */
const REMIND_PAST_SLACK_MS = 60 * 1000

function isReminderEntityType(value: unknown): value is ReminderEntityType {
  return (
    typeof value === 'string' &&
    (REMINDER_ENTITY_TYPES as readonly string[]).includes(value)
  )
}

/**
 * Validate the (entity_type, entity_id) pair every verb takes. Returns the
 * narrowed pair or the 400 to hand back.
 */
function parseEntity(
  entityType: unknown,
  entityId: unknown,
): { entityType: ReminderEntityType; entityId: string } | Response {
  if (!isReminderEntityType(entityType)) {
    return badRequest(
      `entity_type must be one of: ${REMINDER_ENTITY_TYPES.join(', ')}`,
    )
  }
  if (typeof entityId !== 'string' || !UUID_RE.test(entityId)) {
    return badRequest('entity_id must be a uuid')
  }
  return { entityType, entityId }
}

/**
 * GET /api/account/reminders?entity_type=&entity_id=
 *
 * The caller's PENDING reminder for the entity, or null. Delivered rows are
 * history and never surface here — the picker only ever shows/edits the one
 * live reminder.
 *
 * NOT filtered on workspace_id: see the identity note at the top of the file. A
 * reminder set before the entity moved is still the caller's one pending
 * reminder for it, and the picker must be able to show and clear it.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const params = request.nextUrl.searchParams
  const entity = parseEntity(
    params.get('entity_type'),
    params.get('entity_id'),
  )
  if (entity instanceof Response) return entity

  const { data, error } = await supabase
    .from('reminder')
    .select(REMINDER_FIELDS)
    .eq('user_id', user.id)
    .eq('entity_type', entity.entityType)
    .eq('entity_id', entity.entityId)
    .is('delivered_at', null)
    .order('remind_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) return serverError(error.message)

  return NextResponse.json({ reminder: data ?? null })
}

/**
 * POST /api/account/reminders
 * Body: { entity_type, entity_id, remind_at }
 *
 * Sets or RESCHEDULES the caller's pending reminder on the entity.
 */
export async function POST(request: NextRequest) {
  // requireWorkspaceMember, not requireWorkspace: the entity-existence probe
  // below binds the reminder to THIS request's workspace, and only a member of
  // it may file one there (mirroring the INSERT policy's is_workspace_member).
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return badRequest('Invalid JSON body')
  }

  const entity = parseEntity(body.entity_type, body.entity_id)
  if (entity instanceof Response) return entity

  if (typeof body.remind_at !== 'string') {
    return badRequest('remind_at is required')
  }
  const remindAt = new Date(body.remind_at)
  if (Number.isNaN(remindAt.getTime())) {
    return badRequest('remind_at must be a valid date')
  }
  const now = Date.now()
  if (remindAt.getTime() < now - REMIND_PAST_SLACK_MS) {
    return badRequest('remind_at must be in the future')
  }
  if (remindAt.getTime() > now + MAX_REMIND_AHEAD_MS) {
    return badRequest('remind_at must be within two years')
  }
  const remindAtIso = remindAt.toISOString()

  // The entity must exist IN THIS WORKSPACE. Without this a caller could park
  // a reminder on any uuid — the reminder table has no FK to the target (it's
  // polymorphic), so this route is the only place that link is checked.
  // Captures additionally honour the private-visibility predicate so a
  // non-creator can't confirm someone's private capture exists by its id.
  let existsQuery = supabase
    .from(ENTITY_TABLES[entity.entityType])
    .select('id')
    .eq('id', entity.entityId)
    .eq('workspace_id', workspaceId)
  if (entity.entityType === 'capture') {
    existsQuery = existsQuery.or(`visibility.eq.workspace,user_id.eq.${user.id}`)
  }
  const { data: target, error: targetError } = await existsQuery.maybeSingle()

  if (targetError) return serverError(targetError.message)
  if (!target) return notFound(`${entity.entityType} not found`)

  const { data: reminder, error } = await upsertPendingReminder(supabase, {
    workspaceId,
    userId: user.id,
    entityType: entity.entityType,
    entityId: entity.entityId,
    remindAt: remindAtIso,
  })

  if (error) return serverError(error.message)
  if (!reminder) return serverError('Failed to save reminder')

  // Fire-and-forget (trackServerEvent is fail-soft and never throws) — telemetry
  // must not be able to fail a reminder the user has already had persisted.
  trackServerEvent(
    'reminder_set',
    { userId: user.id, workspaceId, email: user.email },
    { entity_type: entity.entityType },
  )

  return NextResponse.json({ reminder })
}

interface UpsertInput {
  workspaceId: string
  userId: string
  entityType: ReminderEntityType
  entityId: string
  remindAt: string
}

/**
 * Upsert the caller's single PENDING reminder for an entity, identified by
 * (user_id, entity_type, entity_id) — the partial unique index's key, and the
 * same key GET and DELETE use.
 *
 * Not a PostgREST `.upsert()`: the uniqueness that defines "pending" lives in a
 * PARTIAL unique index (`… WHERE delivered_at IS NULL`), and ON CONFLICT cannot
 * target a partial index without restating its predicate — something the
 * PostgREST `on_conflict` parameter can't express. So: read, then update-or-
 * insert.
 *
 * That read-then-write is racy (two tabs setting a reminder at once), and the
 * loser's INSERT trips the unique index with 23505. Rather than surface a 500
 * for what is semantically "someone already created the row I was going to",
 * we retry ONCE as the update — converging on the same end state the winner
 * would have produced.
 *
 * RE-HOMING: a pending row stamped with a DIFFERENT workspace than this request
 * is the moved-entity case — the entity now lives here, so the reminder must
 * follow it or the cron will deliver into the workspace the entity left.
 * workspace_id is frozen by migration 224's reminder_freeze_identity trigger
 * (an UPDATE of it is a retarget primitive, not a legitimate edit), so re-homing
 * is a DELETE of the stale row followed by a fresh INSERT — which also clears
 * the unique index for the insert to succeed.
 */
async function upsertPendingReminder(
  supabase: SupabaseClient,
  input: UpsertInput,
): Promise<{ data: unknown; error: { message: string } | null }> {
  // The pending-row identity, restated on each verb below: (user_id,
  // entity_type, entity_id) + delivered_at IS NULL. workspace_id is NOT part of
  // it — see the identity note at the top of the file.
  const insertFresh = async () =>
    await supabase
      .from('reminder')
      .insert({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        remind_at: input.remindAt,
      })
      .select(REMINDER_FIELDS)
      .single()

  const updatePending = async () => {
    const { data, error } = await supabase
      .from('reminder')
      .update({ remind_at: input.remindAt })
      .eq('user_id', input.userId)
      .eq('entity_type', input.entityType)
      .eq('entity_id', input.entityId)
      .is('delivered_at', null)
      .select(REMINDER_FIELDS)
      .maybeSingle()
    return { data, error }
  }

  const deletePending = async () => {
    const { error } = await supabase
      .from('reminder')
      .delete()
      .eq('user_id', input.userId)
      .eq('entity_type', input.entityType)
      .eq('entity_id', input.entityId)
      .is('delivered_at', null)
    return error
  }

  // A fresh insert that converges instead of failing when a concurrent writer
  // already created the pending row (23505 on the partial unique index): retry
  // once as an update, matching what the winner would have produced.
  const insertOrConverge = async () => {
    const { data, error } = await insertFresh()
    if (error && (error as { code?: string }).code === '23505') {
      const retry = await updatePending()
      return { data: retry.data, error: retry.error }
    }
    return { data, error }
  }

  const { data: existing, error: existingError } = await supabase
    .from('reminder')
    .select('id, workspace_id, remind_at')
    .eq('user_id', input.userId)
    .eq('entity_type', input.entityType)
    .eq('entity_id', input.entityId)
    .is('delivered_at', null)
    .maybeSingle()

  if (existingError) return { data: null, error: existingError }

  if (existing) {
    const stale = existing as { workspace_id?: unknown; remind_at?: unknown }
    // Same workspace: a plain reschedule. Otherwise the entity has moved since
    // the reminder was set, so the row must be re-homed — and workspace_id is
    // frozen by the identity trigger, hence delete + re-insert.
    if (stale.workspace_id === input.workspaceId) return await updatePending()
    const deleteError = await deletePending()
    if (deleteError) return { data: null, error: deleteError }
    // The old row is gone; the re-home insert must succeed or the user's
    // reminder is lost. If it fails, restore the original row (its old
    // workspace + remind_at) so a failed re-home is a no-op, not data loss.
    const rehomed = await insertOrConverge()
    if (rehomed.error) {
      await supabase.from('reminder').insert({
        workspace_id: stale.workspace_id,
        user_id: input.userId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        remind_at: stale.remind_at,
      })
      return { data: null, error: rehomed.error }
    }
    return rehomed
  }

  return await insertOrConverge()
}

/**
 * DELETE /api/account/reminders?entity_type=&entity_id=
 *
 * Clears the caller's pending reminder. Idempotent — removing a reminder that
 * isn't there is a success, because the UI's "Remove reminder" row can race the
 * cron delivering it.
 *
 * Same (user_id, entity_type, entity_id) identity as GET and POST, so whatever
 * GET showed is exactly what this clears, whichever workspace the row is
 * stamped with.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const params = request.nextUrl.searchParams
  const entity = parseEntity(
    params.get('entity_type'),
    params.get('entity_id'),
  )
  if (entity instanceof Response) return entity

  const { error } = await supabase
    .from('reminder')
    .delete()
    .eq('user_id', user.id)
    .eq('entity_type', entity.entityType)
    .eq('entity_id', entity.entityId)
    .is('delivered_at', null)

  if (error) return serverError(error.message)

  return NextResponse.json({ ok: true })
}
