import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceFeature } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { collectTrialCaptureIds, deleteEvalCaptures } from '@/app/api/account/evals/delete-captures'
import { deleteCompaniesWithContacts } from '@/lib/crm/delete-companies'
import {
  canDeleteDocument,
  canSetDocumentProject,
  documentUpdateRefusal,
  isSystemDocument,
  loadDocumentsAccess,
  SYSTEM_DOCUMENT_REFUSAL,
  SYSTEM_DOCUMENT_SQLSTATE,
  type DocumentAccess,
} from '@/lib/documents/access'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { BULK_MAX_IDS } from '@/lib/views/types'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/bulk
 *
 * Performs bulk operations on entities. Accepts:
 * - entity_type: the table to operate on
 * - ids: array of entity IDs
 * - action: the operation to perform
 * - value: optional value for the operation (e.g. status, assignee_id)
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()
  const { entity_type, ids, action, value } = body as {
    entity_type: string
    ids: string[]
    action: string
    value?: unknown
  }

  if (!entity_type || !ids?.length || !action) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  if (ids.length > BULK_MAX_IDS) {
    return NextResponse.json(
      { error: `Maximum ${BULK_MAX_IDS} items per bulk operation` },
      { status: 400 },
    )
  }

  // Company deletes cascade to the company's contacts on the service client
  // (see executeBulkAction) — gate them on the same owner/admin rule as
  // /api/account/companies/bulk-delete, since the contact_delete RLS policy
  // reserves contact deletion for creator-or-admin.
  if (entity_type === 'company' && action === 'delete') {
    const { data: member } = await supabase
      .from('member')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (member?.role !== 'owner' && member?.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only workspace owners or admins can delete companies and their people' },
        { status: 403 },
      )
    }
  }

  // Evals is a hidden per-workspace feature and every route in its own REST
  // surface is gated; this generic one must be too, or it becomes the way to
  // delete suites in a workspace that cannot see them.
  if (entity_type === 'eval_suite' || entity_type === 'eval_case') {
    const gated = await requireWorkspaceFeature({ supabase, user, workspaceId }, 'evals')
    if (gated) return gated
  }

  // Labels are workspace-scoped, and the junction tables' RLS only checks the
  // parent row, so every label must be one of this workspace's.
  if (action === 'add_labels' && Array.isArray(value) && value.length > 0) {
    const labelIds = [...new Set(value as string[])]
    const { data: validLabels } = await supabase
      .from('label')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', labelIds)
    if ((validLabels ?? []).length !== labelIds.length) return badRequest('Invalid label IDs')
  }

  // A status is one team's workflow state. Like the single-action PATCH,
  // refuse a state from another team, or the actions land in a column their
  // board does not have.
  if (entity_type === 'action' && action === 'change_status' && typeof value === 'string' && value) {
    const { data: state } = await supabase
      .from('workflow_state')
      .select('id, team_id')
      .eq('id', value)
      .maybeSingle()
    const { data: rows } = await supabase
      .from('actions')
      .select('id, team_id')
      .in('id', ids)
      .eq('workspace_id', workspaceId)
    const foreign = (rows ?? []).some(
      (r: { team_id: string | null }) => r.team_id && r.team_id !== state?.team_id,
    )
    if (!state || foreign) return badRequest('Invalid status_id')
  }

  try {
    const result = await executeBulkAction(supabase, user.id, workspaceId, entity_type, ids, action, value)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

// ── Table mapping ────────────────────────────────────────────

const ENTITY_TABLE: Record<string, string> = {
  action: 'actions',
  capture: 'captures',
  contact: 'contact',
  company: 'company',
  document: 'document',
  initiative: 'initiative',
  project: 'projects',
  email_thread: 'email_threads',
  flow: 'flow',
  sequence: 'sequence',
  eval_suite: 'eval_suite',
  eval_case: 'eval_case',
  claim: 'claim',
  // NO 'eval_run'. There is no single-record DELETE for a run either: a run is
  // the immutable record of one execution, and its trials are the durable
  // evidence a compare view reads. BULK_ACTIONS.eval_run is [] to match, so
  // this route is never reached for one — the mapping is left out rather than
  // pointed at the table so a future caller gets "Unsupported entity type"
  // instead of a working bulk delete nobody designed.
}

// Entity types scoped by workspace membership only (no per-user owner column).
// Flows are workspace-shared automations — any member can manage them, matching
// the single-record /api/account/flows/:id DELETE which uses requireWorkspaceMember.
// Sequences are workspace artifacts under the same model (workspace-member RLS,
// matching the /api/account/sequences/:id routes which use requireWorkspace).
// CRM tables (contact, company — singular, migration 033) have NO user_id
// column at all: they are workspace-scoped only, so any owner-column filter
// would error.
// eval_suite is workspace-scoped too: migration 252's RLS is is_workspace_member
// and eval_suite.created_by references auth.users(id), not a member row, so an
// owner-column filter would compare disjoint UUID spaces and delete nothing.
// eval_case is workspace-scoped for the same reason as eval_suite: 252's RLS
// is is_workspace_member (plus a creator-only carve-out for `visibility =
// 'private'`, which the caller's client enforces on its own), and
// eval_case.created_by references auth.users(id) rather than a member row.
// `claim` is workspace-scoped as well: migration 109's RLS is workspace
// membership, and `claim.created_by` is a NULLABLE `member(id)` — not an owner
// user id — so an owner-column filter would both compare disjoint UUID spaces
// and exclude every machine-extracted claim, which is nearly all of them.
const WORKSPACE_SCOPED = new Set(['flow', 'sequence', 'contact', 'company', 'eval_suite', 'eval_case', 'claim'])

// Entity types whose bulk DELETE follows their single-record DELETE route
// rather than the owner column: scoped to the workspace, with RLS deciding
// who may delete. For actions that is `actions_delete` (migration 028) —
// owners and admins can delete any action in the workspace, members none —
// exactly what DELETE /api/account/actions/:id enforces. Their other bulk
// operations keep the owner column.
const DELETE_WORKSPACE_SCOPED = new Set(['action'])

// ── Owner column per entity (for scoping to user's workspace) ──

// `document` has no owner column: who may change one is migration 359's rule,
// applied per row by executeDocumentBulkUpdate below.
const OWNER_COLUMN: Record<string, string> = {
  actions: 'user_id',
  captures: 'user_id',
  initiative: 'user_id',
  projects: 'user_id',
  email_threads: 'user_id',
}

async function executeBulkAction(
  supabase: any,
  userId: string,
  workspaceId: string,
  entityType: string,
  ids: string[],
  action: string,
  value: unknown,
): Promise<{ success: number; failed: number; errors?: string[] }> {
  const table = ENTITY_TABLE[entityType]
  if (!table) throw new Error(`Unknown entity type: ${entityType}`)
  // Documents (other than delete, which the RPC gates) follow migration 359's
  // creator-or-admin rule, row by row, like the single-document routes.
  if (entityType === 'document' && action !== 'delete') {
    return executeDocumentBulkUpdate(supabase, userId, workspaceId, ids, action, value)
  }
  const ownerCol = OWNER_COLUMN[table] || 'user_id'
  const workspaceScoped = WORKSPACE_SCOPED.has(entityType)

  let success = 0
  let failed = 0
  const errors: string[] = []
  // Updates ask for count: 'exact' so rows the owner filter or RLS skipped are
  // reported as failed, with a reason, instead of claiming every id changed.
  const tally = (changed: number | null) => {
    success = changed ?? 0
    failed = ids.length - success
    if (failed > 0) {
      errors.push('they may already be gone, belong to someone else, or you may not have permission to change them')
    }
  }

  switch (action) {
    // ── Delete ─────────────────────────────────────────────
    case 'delete': {
      // Captures and documents must NOT be bulk-deleted with a raw
      // .from(table).delete(). claim_source.source_id and
      // entity_link.{source,target}_id are polymorphic bare UUIDs with NO
      // foreign key (migration 109), so a bare row delete strands every claim
      // learned only from that capture/document as evidence-orphaned while its
      // embeddings survive and keep surfacing in RAG. We route each id through
      // the same SECURITY DEFINER teardown RPCs the single-item DELETE handlers
      // use (migration 178) — they partition sole-sourced claims from shared
      // ones, hard-delete the former, prune the latter's evidence + mirrored
      // edges, and delete the row, atomically and owner-only. One id's failure
      // must not abort the batch, so we loop and tally per id rather than
      // letting a throw unwind the whole request.
      if (entityType === 'capture' || entityType === 'document') {
        const rpcName = entityType === 'capture'
          ? 'delete_capture_with_knowledge'
          : 'delete_document_with_knowledge'
        const idParam = entityType === 'capture' ? 'p_capture_id' : 'p_document_id'
        const notFoundLabel = entityType === 'capture' ? 'Capture not found' : 'Document not found'
        for (const id of ids) {
          const { error } = await supabase.rpc(rpcName, {
            [idParam]: id,
            p_workspace_id: workspaceId,
          })
          if (error) {
            failed++
            // P0002 = not found (or not owned); 42501 = not allowed; P0013 = a
            // system document (migration 366). Surface a friendlier line for
            // those; fall back to the raw message otherwise.
            const code = (error as { code?: string }).code
            if (code === 'P0002') errors.push(`${id}: ${notFoundLabel}`)
            else if (code === '42501') errors.push(`${id}: Not allowed`)
            else if (code === SYSTEM_DOCUMENT_SQLSTATE) errors.push(`${id}: ${SYSTEM_DOCUMENT_REFUSAL}`)
            else errors.push(`${id}: ${error.message}`)
          } else {
            success++
          }
        }
        break
      }

      // Eval suites: mirror the single-record DELETE
      // (/api/account/evals/suites/[id]) rather than issuing a bare row
      // delete, because that route does two things the cascade cannot.
      // A suite with a run IN FLIGHT is refused — the Inngest lane would keep
      // writing trials against a suite that no longer exists. And the suite's
      // EVAL CAPTURES outlive the cascade: the composite FK runs case →
      // capture and trial → capture, so deleting the suite leaves each case's
      // template AND every run's per-trial clone as `is_eval` rows no screen
      // lists and nothing else ever collects. Cleanup runs on the service
      // client AFTER the cascade lands, never before (a capture deleted first
      // would take its case down with it while the suite delete could still
      // fail).
      if (entityType === 'eval_suite') {
        const { data: liveRuns } = await supabase
          .from('eval_run')
          .select('suite_id')
          .in('suite_id', ids)
          .eq('is_live', true)
        const live = new Set(((liveRuns ?? []) as { suite_id: string }[]).map(r => r.suite_id))
        const deletable = ids.filter(id => !live.has(id))
        for (const id of live) {
          failed++
          errors.push(`${id}: This suite has a run in flight. Stop it first.`)
        }
        if (deletable.length === 0) break

        const { data: cases } = await supabase
          .from('eval_case')
          .select('id, capture_id')
          .in('suite_id', deletable)
          .eq('workspace_id', workspaceId)

        const caseRows = (cases ?? []) as { id: string; capture_id: string }[]
        const service = getServiceClient()
        // Before the cascade: a run's per-trial CLONE captures are recorded
        // only on eval_trial, which the suite delete cascades away.
        const trialCaptureIds = await collectTrialCaptureIds(
          service,
          workspaceId,
          caseRows.map(c => c.id),
        )

        const { error, count } = await supabase
          .from('eval_suite')
          .delete({ count: 'exact' })
          .in('id', deletable)
          .eq('workspace_id', workspaceId)
        if (error) throw error
        success = count ?? 0
        failed += deletable.length - success

        await deleteEvalCaptures(service, workspaceId, [
          ...caseRows.map(c => c.capture_id),
          ...trialCaptureIds,
        ])
        break
      }

      // Eval cases: mirror the single-record DELETE
      // (/api/account/evals/cases/[id]) rather than a bare row delete, for the
      // one thing the cascade cannot do. A case's EVAL CAPTURES outlive it:
      // the composite FK runs case → capture and trial → capture (252), so
      // deleting the case leaves its template and every trial clone as
      // `is_eval` captures that no screen lists and nothing else ever
      // collects. Same ordering rule as the suite branch above — capture
      // cleanup runs on the service client AFTER the rows are gone, never
      // before, because a capture deleted first would take its case down with
      // it while the case delete could still fail.
      //
      // No live-run refusal here, unlike the suite branch: a case delete
      // during a run does not orphan the Inngest lane (eval_trial cascades
      // from the case and the run survives with fewer trials), and refusing
      // would block ordinary authoring for as long as any run is in flight.
      if (entityType === 'eval_case') {
        const { data: cases } = await supabase
          .from('eval_case')
          .select('capture_id')
          .in('id', ids)
          .eq('workspace_id', workspaceId)

        const service = getServiceClient()
        // Same as the suite branch: collect the trial clones before the
        // cascade that takes eval_trial with it.
        const trialCaptureIds = await collectTrialCaptureIds(service, workspaceId, ids)

        const { error, count } = await supabase
          .from('eval_case')
          .delete({ count: 'exact' })
          .in('id', ids)
          .eq('workspace_id', workspaceId)
        if (error) throw error
        success = count ?? 0
        failed = ids.length - success

        await deleteEvalCaptures(service, workspaceId, [
          ...((cases ?? []) as { capture_id: string }[]).map(c => c.capture_id),
          ...trialCaptureIds,
        ])
        break
      }

      // Company deletes cascade to the company's contacts — same helper the
      // dedicated /api/account/companies delete routes use. Runs on the
      // service client because the contact_delete RLS policy would let rows
      // survive while the company dies (see the helper's doc); the POST
      // handler above gates this on an owner/admin role check.
      if (entityType === 'company') {
        const result = await deleteCompaniesWithContacts(
          getServiceClient(),
          workspaceId,
          ids,
        )
        success = result.companies
        failed = ids.length - result.companies
        break
      }

      // count: 'exact' so rows RLS refuses to delete (e.g. the creator-or-
      // admin contact_delete policy) are reported as failed instead of the
      // response claiming every requested id was deleted.
      let del = supabase
        .from(table)
        .delete({ count: 'exact' })
        .in('id', ids)
        .eq('workspace_id', workspaceId)
      // Workspace-scoped entities (flows) and DELETE_WORKSPACE_SCOPED ones
      // (actions) leave the decision to RLS; others are scoped to the
      // requesting user's own rows.
      const ownerScoped = !workspaceScoped && !DELETE_WORKSPACE_SCOPED.has(entityType)
      if (ownerScoped) del = del.eq(ownerCol, userId)
      const { error, count } = await del
      if (error) throw error
      success = count ?? 0
      failed = ids.length - success
      // Rows the filters or RLS skipped are not an error to Postgres, so say
      // why here — `failed` carries the count, the client shows this reason.
      if (failed > 0) {
        errors.push(
          ownerScoped
            ? 'they may already be gone, belong to someone else, or need a workspace owner or admin to delete'
            : 'they may already be gone, or you may not have permission to delete them',
        )
      }
      break
    }

    // ── Archive (soft-delete via status) ──────────────────
    case 'archive': {
      // Sequences: archive is a lifecycle transition, not a bare column flip.
      // Mirror the single-record PATCH (/api/account/sequences/[id]): status
      // → 'archived', auto_send off (the emergency brake — the Inngest send
      // function re-checks it per step), and every ACTIVE enrollment exits as
      // 'removed' with its schedule cleared so the dispatcher never claims it
      // again. Workspace-scoped (no owner column), like the single route.
      if (entityType === 'sequence') {
        const { data: archived, error } = await supabase
          .from(table)
          .update({ status: 'archived', auto_send: false })
          .in('id', ids)
          .eq('workspace_id', workspaceId)
          .select('id')
        if (error) throw error
        // Only exit enrollments of the sequences this update actually archived.
        const archivedIds = ((archived ?? []) as { id: string }[]).map(r => r.id)
        if (archivedIds.length > 0) {
          const { error: exitError } = await supabase
            .from('sequence_enrollment')
            .update({ status: 'exited', exit_reason: 'removed', next_send_at: null })
            .in('sequence_id', archivedIds)
            .eq('status', 'active')
          if (exitError) throw exitError
        }
        tally(archivedIds.length)
        break
      }

      const statusField = entityType === 'capture' ? 'status' : 'is_archived'
      const statusValue = entityType === 'capture' ? 'archived' : true
      const { error, count } = await supabase
        .from(table)
        .update({ [statusField]: statusValue }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Change status ────────────────────────────────────
    case 'change_status': {
      if (!value) throw new Error('Status value required')
      // Actions use status_id, others use status string
      const field = entityType === 'action' ? 'status_id' : 'status'

      // Snapshot the affected actions BEFORE the write: emitStatusChange needs
      // each action's team (flow matching is team-scoped) and its FROM status,
      // both of which the update destroys. Same scoping as the update below so
      // we never emit for a row the update couldn't touch.
      let previous: Array<{ id: string; team_id: string | null; status_id: string | null }> = []
      if (entityType === 'action') {
        const { data } = await supabase
          .from(table)
          .select('id, team_id, status_id')
          .in('id', ids)
          .eq(ownerCol, userId)
          .eq('workspace_id', workspaceId)
        previous = data ?? []
      }

      const { error, count } = await supabase
        .from(table)
        .update({ [field]: value }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)

      // Fire the status-change trigger per affected action — the same emit the
      // single-action PATCH uses (GEN-112). Bulk status changes are a real
      // writer that was silently skipping Flows (and, now, the Asana echo).
      // emitStatusChange self-guards on "no team" / "status didn't change", so
      // rows that only look affected cost nothing. Fire-and-forget: it never
      // blocks or fails the bulk response.
      if (entityType === 'action') {
        for (const row of previous) {
          emitStatusChange({
            entityType: 'action',
            entityId: row.id,
            workspaceId,
            teamId: row.team_id,
            fromStatusId: row.status_id,
            toStatusId: value as string,
            actorUserId: userId,
          })
        }
      }
      break
    }

    // ── Assign to (actions) ──────────────────────────────
    case 'assign_to': {
      const { data: assigned, error } = await supabase
        .from(table)
        .update({ assignee_id: value || null })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
        .select('id')
      if (error) throw error
      // Sync action_assignee join table — only for the rows the update touched,
      // so actions the owner filter skipped keep their assignees.
      const assignedIds = ((assigned ?? []) as { id: string }[]).map(r => r.id)
      if (table === 'actions' && assignedIds.length > 0) {
        const { error: unseatError } = await supabase
          .from('action_assignee')
          .delete()
          .in('action_id', assignedIds)
        if (unseatError) throw unseatError
        if (value) {
          const { error: seatError } = await supabase.from('action_assignee').insert(
            assignedIds.map((actionId: string) => ({ action_id: actionId, member_id: value }))
          )
          if (seatError) throw seatError
        }
      }
      tally(assignedIds.length)
      break
    }

    // ── Set priority (actions) ───────────────────────────
    case 'set_priority': {
      if (!value) throw new Error('Priority value required')
      const { error, count } = await supabase
        .from(table)
        .update({ priority: value }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Set project ──────────────────────────────────────
    case 'set_project': {
      const { error, count } = await supabase
        .from(table)
        .update({ project_id: value || null }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Set initiative (projects) ────────────────────────
    case 'set_initiative': {
      const { error, count } = await supabase
        .from(table)
        .update({ initiative_id: value || null }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Set owner (initiatives) ──────────────────────────
    case 'set_owner': {
      const { error, count } = await supabase
        .from(table)
        .update({ owner_id: value || null }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Set lead (projects) ──────────────────────────────
    case 'set_lead': {
      const { error, count } = await supabase
        .from(table)
        .update({ lead_id: value || null }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Set relationship type (contacts) ─────────────────
    case 'set_relationship_type': {
      if (!value) throw new Error('Relationship type required')
      // Contacts have no user_id column — workspace-scoped only.
      let upd = supabase
        .from(table)
        .update({ relationship_type: value }, { count: 'exact' })
        .in('id', ids)
        .eq('workspace_id', workspaceId)
      if (!workspaceScoped) upd = upd.eq(ownerCol, userId)
      const { error, count } = await upd
      if (error) throw error
      tally(count)
      break
    }

    // ── Add labels (actions, initiatives, projects — junction table) ──
    case 'add_labels': {
      // Deduped: a repeated id in one multi-row upsert fails with "cannot
      // affect row a second time".
      const labelIds = Array.isArray(value) ? [...new Set(value as string[])] : []
      if (!labelIds?.length) throw new Error('Label IDs required')

      if (entityType === 'action') {
        // Verify all action IDs belong to this workspace before junction upsert
        const { data: validActions } = await supabase
          .from('actions')
          .select('id')
          .in('id', ids)
          .eq('workspace_id', workspaceId)
        const validIds = new Set((validActions || []).map((a: { id: string }) => a.id))

        // action_label junction table. Counts are per action, not per label
        // assignment: an action fails if it is outside the workspace or any of
        // its label upserts fails.
        const failedIds = new Set<string>()
        for (const id of ids) {
          if (!validIds.has(id)) { failedIds.add(id); continue }
          for (const labelId of labelIds) {
            const { error } = await supabase
              .from('action_label')
              .upsert({ action_id: id, label_id: labelId }, { onConflict: 'action_id,label_id' })
            if (error) { failedIds.add(id); errors.push(`${id}: ${error.message}`) }
          }
        }
        failed = failedIds.size
        success = ids.length - failed
      } else {
        // Projects/initiatives use the project_label / initiative_label
        // junction tables (migrations 044/045), like the single-record PATCH
        // routes. Their RLS only checks the parent row, so the parents must be
        // in this workspace (POST has already checked the labels are).
        const junction = entityType === 'project'
          ? { table: 'project_label', fk: 'project_id' }
          : entityType === 'initiative'
            ? { table: 'initiative_label', fk: 'initiative_id' }
            : null
        if (!junction) throw new Error(`Labels are not supported for ${entityType}`)
        const { data: validRows } = await supabase
          .from(table)
          .select('id')
          .in('id', ids)
          .eq('workspace_id', workspaceId)
        const validIds = new Set((validRows || []).map((r: { id: string }) => r.id))
        for (const id of ids) {
          if (!validIds.has(id)) { failed++; continue }
          const { error } = await supabase
            .from(junction.table)
            .upsert(
              labelIds.map((labelId) => ({ [junction.fk]: id, label_id: labelId })),
              { onConflict: `${junction.fk},label_id` },
            )
          if (error) { failed++; errors.push(`${id}: ${error.message}`) }
          else success++
        }
      }
      break
    }

    // ── Add tags (contacts, companies) ───────────────────
    case 'add_tags': {
      const newTags = value as string[]
      if (!newTags?.length) throw new Error('Tags required')
      for (const id of ids) {
        const { data: current } = await supabase
          .from(table)
          .select('tags')
          .eq('id', id)
          .single()
        const existing: string[] = (current?.tags as string[]) || []
        const merged = [...new Set([...existing, ...newTags])]
        // Contacts and companies have no user_id column — workspace-scoped only.
        // count: 'exact' because a row the caller may only view (contact
        // UPDATE RLS is can_edit_contact) or one that is gone matches 0 rows
        // without an error, like the siblings' tally.
        let upd = supabase
          .from(table)
          .update({ tags: merged }, { count: 'exact' })
          .eq('id', id)
          .eq('workspace_id', workspaceId)
        if (!workspaceScoped) upd = upd.eq(ownerCol, userId)
        const { error, count } = await upd
        if (error) { failed++; errors.push(`${id}: ${error.message}`) }
        else if (!count) { failed++; errors.push(`${id}: not found or not editable`) }
        else success++
      }
      break
    }

    // ── Pin / Unpin ──────────────────────────────────────
    case 'pin':
    case 'unpin': {
      const { error, count } = await supabase
        .from(table)
        .update({ is_pinned: action === 'pin' }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Email: move to folder ────────────────────────────
    case 'move_to_folder': {
      if (!value) throw new Error('Folder value required')
      const { error, count } = await supabase
        .from(table)
        .update({ folder: value }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Email: mark read/unread ──────────────────────────
    case 'mark_read':
    case 'mark_unread': {
      const { error, count } = await supabase
        .from(table)
        .update({ is_unread: action === 'mark_unread' }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Email: star/unstar ───────────────────────────────
    case 'star':
    case 'unstar': {
      const { error, count } = await supabase
        .from(table)
        .update({ is_starred: action === 'star' }, { count: 'exact' })
        .in('id', ids)
        .eq(ownerCol, userId)
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    // ── Knowledge: confirm / dismiss claims ──────────────
    // The review queue's two verbs, applied to a selection. Confirming stamps
    // `last_verified_at` exactly as the single-record routes do
    // (/api/account/claims/[id] and .../confirm), because the library's "last
    // verified" rollup reads it — a bulk confirm that skipped the stamp would
    // leave a freshly-confirmed claim reading as never verified. Dismissing
    // does NOT stamp it: dismissal is not verification.
    case 'confirm_claim':
    case 'dismiss_claim': {
      const confirming = action === 'confirm_claim'
      const patch: Record<string, unknown> = {
        confirmation: confirming ? 'confirmed' : 'dismissed',
      }
      if (confirming) patch.last_verified_at = new Date().toISOString()
      const { error, count } = await supabase
        .from(table)
        .update(patch, { count: 'exact' })
        .in('id', ids)
        // Workspace-scoped only — see WORKSPACE_SCOPED. `claim.created_by` is a
        // nullable member id, not an owner user id, so an owner-column filter
        // would compare disjoint UUID spaces and update nothing.
        .eq('workspace_id', workspaceId)
      if (error) throw error
      tally(count)
      break
    }

    default:
      throw new Error(`Unknown bulk action: ${action}`)
  }

  return { success, failed, ...(errors.length > 0 ? { errors } : {}) }
}

// ── Documents: who may change one (migration 359) ───────────

/** Postgres insufficient_privilege: the 359 guard raised. */
const NOT_ALLOWED = '42501'

/**
 * A document bulk update, gated the way /api/account/documents/[id] gates the
 * single one (src/lib/documents/access.ts, one batched access read):
 *
 *   archive, change_status  archiving is delete-level (canDeleteDocument:
 *   to archived             owner/admin, or the creator except the product
 *                           doc). Written on the service client after that
 *                           check, like the single archive: the creator of a
 *                           spec page may archive it though RLS won't let them
 *                           edit it. Any other status (un-archiving) is an
 *                           edit, like the single PATCH (below).
 *   pin, unpin, set_project edit-level (documentUpdateRefusal, plus
 *                           canSetDocumentProject for a move). Written on the
 *                           session client, like the single PATCH, so RLS and
 *                           the 359 guard back the app check up.
 *
 * A refused row is reported as `<id>: Not allowed` and the rest still go
 * through; a row not in the workspace is `<id>: Document not found`.
 */
async function executeDocumentBulkUpdate(
  supabase: any,
  userId: string,
  workspaceId: string,
  ids: string[],
  action: string,
  value: unknown,
): Promise<{ success: number; failed: number; errors?: string[] }> {
  let patch: Record<string, unknown>
  switch (action) {
    case 'archive':
      patch = { status: 'archived' }
      break
    case 'change_status':
      if (!value) throw new Error('Status value required')
      patch = { status: value }
      break
    case 'pin':
    case 'unpin':
      patch = { is_pinned: action === 'pin' }
      break
    case 'set_project':
      patch = { project_id: value || null }
      break
    default:
      throw new Error(`Unknown bulk action for documents: ${action}`)
  }
  // Only archiving is delete-level (written on the service client after
  // canDeleteDocument). Any other status, such as un-archiving to 'active', is
  // an edit like the single PATCH: edit-level check, session client.
  const deleteLevel = patch.status === 'archived'

  const { access, error: accessError } = await loadDocumentsAccess(supabase, workspaceId, userId, ids)
  if (accessError) throw new Error(accessError)

  let success = 0
  let failed = 0
  const errors: string[] = []
  const allowed: string[] = []
  const mayChange = (a: DocumentAccess): boolean =>
    deleteLevel
      ? canDeleteDocument(a)
      : (action !== 'set_project' || canSetDocumentProject(a)) && documentUpdateRefusal(a, patch) === null
  for (const id of ids) {
    const a = access.get(id)
    if (!a) {
      failed++
      errors.push(`${id}: Document not found`)
    } else if (deleteLevel && isSystemDocument(a)) {
      // A system document (migration 366) is never archived, by anyone.
      failed++
      errors.push(`${id}: ${SYSTEM_DOCUMENT_REFUSAL}`)
    } else if (!mayChange(a)) {
      failed++
      errors.push(`${id}: Not allowed`)
    } else {
      allowed.push(id)
    }
  }

  if (allowed.length > 0) {
    if (deleteLevel) {
      const { data, error } = await getServiceClient()
        .from('document')
        .update(patch)
        .in('id', allowed)
        .eq('workspace_id', workspaceId)
        .select('id')
      if (error) throw error
      const written = new Set(((data ?? []) as { id: string }[]).map((r) => r.id))
      for (const id of allowed) {
        if (written.has(id)) success++
        else {
          failed++
          errors.push(`${id}: Document not found`)
        }
      }
    } else {
      // Track who edited last, as the single PATCH does.
      const memberId = access.get(allowed[0])?.memberId ?? null
      const write = memberId ? { ...patch, last_edited_by: memberId } : patch
      const update = (targets: string[]) =>
        supabase
          .from('document')
          .update(write)
          .in('id', targets)
          .eq('workspace_id', workspaceId)
          .select('id')
      const { data, error } = await update(allowed)
      // The guard raises for the whole statement; the app check mirrors it,
      // so this is a race. Retry row by row so only the refused ones fail.
      const results: Array<{ ids: string[]; data: unknown; error: { code?: string; message: string } | null }> =
        error && (error as { code?: string }).code === NOT_ALLOWED
          ? await Promise.all(allowed.map(async (id) => ({ ids: [id], ...(await update([id])) })))
          : [{ ids: allowed, data, error }]
      for (const r of results) {
        if (r.error && r.error.code !== NOT_ALLOWED) throw r.error
        // RLS refusing a row is not an error to Postgres: it just isn't returned.
        const written = new Set(((r.error ? [] : r.data ?? []) as { id: string }[]).map((row) => row.id))
        for (const id of r.ids) {
          if (written.has(id)) success++
          else {
            failed++
            errors.push(`${id}: Not allowed`)
          }
        }
      }
    }
  }

  return { success, failed, ...(errors.length > 0 ? { errors } : {}) }
}
