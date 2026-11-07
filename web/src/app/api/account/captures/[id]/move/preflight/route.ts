/**
 * GET /api/account/captures/[id]/move/preflight
 *
 * Returns what would happen if the user moved this capture to another
 * workspace. Used by the move dialog to render an honest disclosure and to
 * surface the choices the move endpoint expects:
 *
 *   - `confirmed_actions` — every confirmed action extracted from this
 *     capture, flagged `edited` when it drifted from the AI proposal that
 *     created it, accreted comments/labels/PR links, or is synced to an
 *     external tracker (the move severs that link). The dialog pre-checks
 *     the untouched ones and leaves edited ones for the user to decide.
 *   - `shares_active` — live public/email share links on the capture. The
 *     move deactivates them in place (migration 221): the token dies and the
 *     external commenters' rows stay in the source workspace.
 *   - `claims` — how many knowledge claims are solely evidenced by this
 *     capture (move by default) vs shared with other sources (stay behind).
 *   - `contacts` — participant contacts that were auto-created from this
 *     capture's attendees (copied to the destination) vs the rest (stay).
 *
 * No destination_workspace_id is needed for the preflight — the counts are
 * the same regardless of where the capture moves to (the destination only
 * matters for permission checks, which are enforced at move time).
 *
 * Scoped to the caller's CURRENT workspace. A user with access to multiple
 * workspaces can only preflight captures in the workspace they're actively
 * viewing — without this scope they could probe any capture they have RLS
 * access to, leaking cross-workspace counts.
 */
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import {
  computeConfirmedActionSignals,
  partitionClaimsBySource,
  splitParticipantContacts,
  type AppliedActionProposal,
  type ClaimSourceRow,
  type ConfirmedActionRow,
  type ParticipantContactRow,
} from '@/lib/captures/move-artifacts'
import { NextResponse } from 'next/server'

/** PostgREST results don't throw; every query carries its own .error field.
 * Silently under-counting would defeat the purpose of the disclosure, so any
 * errored query fails the whole preflight loudly. */
function firstError(
  results: { error: { message: string } | null }[],
): string | null {
  const failed = results.find((r) => r.error)
  return failed?.error?.message ?? null
}

const EMPTY = Promise.resolve({ data: [], error: null } as {
  data: never[]
  error: null
})

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id: captureId } = await params

  // Belt-and-suspenders: RLS already filters captures by workspace membership,
  // but we additionally pin to the caller's current workspace so users with
  // access to multiple workspaces can't preflight captures outside the one
  // they're actively viewing.
  const { data: capture, error: captureErr } = await supabase
    .from('captures')
    .select('id, workspace_id')
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (captureErr) {
    console.error('[move_preflight] capture lookup failed:', captureErr.message)
    return serverError('Preflight failed')
  }
  if (!capture) return notFound('Capture not found')

  // Round 1 — the capture's direct children.
  const round1 = await Promise.all([
    supabase
      .from('actions')
      .select('id, identifier, title, description')
      .eq('source_capture_id', captureId)
      .eq('confirmation', 'confirmed'),
    supabase
      .from('actions')
      .select('id', { count: 'exact', head: true })
      .eq('source_capture_id', captureId)
      .eq('confirmation', 'suggested'),
    supabase
      .from('decision')
      .select('id', { count: 'exact', head: true })
      .eq('capture_id', captureId)
      .eq('confirmation', 'confirmed'),
    supabase
      .from('decision')
      .select('id', { count: 'exact', head: true })
      .eq('capture_id', captureId)
      .eq('confirmation', 'suggested'),
    supabase
      .from('proposed_change')
      .select('id', { count: 'exact', head: true })
      .eq('capture_id', captureId)
      .eq('status', 'pending'),
    supabase.from('attachments').select('id').eq('note_id', captureId),
    supabase
      .from('capture_participant')
      .select('contact_id')
      .eq('capture_id', captureId)
      .not('contact_id', 'is', null),
    supabase
      .from('share')
      .select('id', { count: 'exact', head: true })
      .eq('shareable_type', 'capture')
      .eq('shareable_id', captureId)
      .eq('workspace_id', workspaceId)
      .eq('is_active', true),
  ])

  const round1Error = firstError(round1)
  if (round1Error) {
    console.error('[move_preflight] count query failed:', round1Error)
    return serverError('Preflight failed')
  }

  const [
    confirmedActionsRes,
    suggestedActions,
    confirmedDecisions,
    suggestedDecisions,
    pendingProposals,
    attachmentsRes,
    participantsRes,
    activeShares,
  ] = round1

  const confirmedActions = (confirmedActionsRes.data ?? []) as ConfirmedActionRow[]
  const confirmedActionIds = confirmedActions.map((a) => a.id)
  const attachmentIds = ((attachmentsRes.data ?? []) as { id: string }[]).map(
    (a) => a.id,
  )
  const participantContactIds = [
    ...new Set(
      ((participantsRes.data ?? []) as { contact_id: string | null }[])
        .map((p) => p.contact_id)
        .filter((id): id is string => id !== null),
    ),
  ]

  // Round 2 — edit signals for confirmed actions, claim evidence pointing at
  // the capture, and the participants' contact rows. Queries whose id list is
  // empty are skipped rather than sent as `IN ()`.
  const round2 = await Promise.all([
    confirmedActionIds.length > 0
      ? supabase
          .from('proposed_change')
          .select('result_entity_id, title, description')
          .eq('capture_id', captureId)
          .eq('entity_type', 'action')
          .eq('change_type', 'create')
          .eq('status', 'applied')
      : EMPTY,
    confirmedActionIds.length > 0
      ? supabase
          .from('comment')
          .select('commentable_id')
          .eq('commentable_type', 'action')
          .in('commentable_id', confirmedActionIds)
      : EMPTY,
    confirmedActionIds.length > 0
      ? supabase
          .from('action_label')
          .select('action_id')
          .in('action_id', confirmedActionIds)
      : EMPTY,
    confirmedActionIds.length > 0
      ? supabase
          .from('action_github_pr')
          .select('action_id')
          .in('action_id', confirmedActionIds)
      : EMPTY,
    // Jira/Linear/Asana links. The move severs them (a re-stamped row would
    // authenticate the provider echo against the destination's account for a
    // source-tenant issue id), so a synced action is ambiguous to move.
    confirmedActionIds.length > 0
      ? supabase
          .from('action_external_task')
          .select('action_id')
          .eq('workspace_id', workspaceId)
          .in('action_id', confirmedActionIds)
      : EMPTY,
    supabase
      .from('claim_source')
      .select('claim_id')
      .eq('source_type', 'capture')
      .eq('source_id', captureId),
    attachmentIds.length > 0
      ? supabase
          .from('claim_source')
          .select('claim_id')
          .eq('source_type', 'attachment')
          .in('source_id', attachmentIds)
      : EMPTY,
    participantContactIds.length > 0
      ? supabase
          .from('contact')
          .select('id, full_name, email, source')
          .eq('workspace_id', workspaceId)
          .in('id', participantContactIds)
      : EMPTY,
  ])

  const round2Error = firstError(round2)
  if (round2Error) {
    console.error('[move_preflight] artifact query failed:', round2Error)
    return serverError('Preflight failed')
  }

  const [
    proposalsRes,
    commentsRes,
    labelsRes,
    prsRes,
    externalTasksRes,
    captureClaimSourcesRes,
    attachmentClaimSourcesRes,
    contactsRes,
  ] = round2

  const linkedClaimIds = [
    ...new Set(
      [
        ...((captureClaimSourcesRes.data ?? []) as { claim_id: string }[]),
        ...((attachmentClaimSourcesRes.data ?? []) as { claim_id: string }[]),
      ].map((r) => r.claim_id),
    ),
  ]

  // Round 3 — scope the linked claims to this workspace (claim_source has no
  // workspace of its own), then load ALL their evidence rows so the
  // sole-vs-shared partition sees sources beyond this capture.
  let claimIds: string[] = []
  let claimSourceRows: ClaimSourceRow[] = []
  if (linkedClaimIds.length > 0) {
    const claimsRes = await supabase
      .from('claim')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', linkedClaimIds)
    if (claimsRes.error) {
      console.error('[move_preflight] claim query failed:', claimsRes.error.message)
      return serverError('Preflight failed')
    }
    claimIds = ((claimsRes.data ?? []) as { id: string }[]).map((c) => c.id)

    if (claimIds.length > 0) {
      const sourcesRes = await supabase
        .from('claim_source')
        .select('claim_id, source_type, source_id')
        .in('claim_id', claimIds)
      if (sourcesRes.error) {
        console.error(
          '[move_preflight] claim_source query failed:',
          sourcesRes.error.message,
        )
        return serverError('Preflight failed')
      }
      claimSourceRows = (sourcesRes.data ?? []) as ClaimSourceRow[]
    }
  }

  const actionSignals = computeConfirmedActionSignals({
    actions: confirmedActions,
    proposals: (proposalsRes.data ?? []) as AppliedActionProposal[],
    commentedActionIds: ((commentsRes.data ?? []) as { commentable_id: string }[]).map(
      (c) => c.commentable_id,
    ),
    labeledActionIds: ((labelsRes.data ?? []) as { action_id: string }[]).map(
      (l) => l.action_id,
    ),
    prLinkedActionIds: ((prsRes.data ?? []) as { action_id: string }[]).map(
      (p) => p.action_id,
    ),
    externalLinkedActionIds: (
      (externalTasksRes.data ?? []) as { action_id: string }[]
    ).map((t) => t.action_id),
  })

  const { soleSourced, shared } = partitionClaimsBySource(
    claimIds,
    claimSourceRows,
    captureId,
    attachmentIds,
  )

  const { autoCreated, other: otherContacts } = splitParticipantContacts(
    (contactsRes.data ?? []) as ParticipantContactRow[],
  )

  return NextResponse.json({
    capture_id: captureId,
    source_workspace_id: capture.workspace_id,
    // Confirmed actions stay behind unless the caller lists them in the move
    // request. Kept under the legacy name for existing clients.
    accepted_actions_unlinked: confirmedActions.length,
    // What follows the capture
    pending_suggestions: pendingProposals.count ?? 0,
    suggested_actions: suggestedActions.count ?? 0,
    confirmed_decisions: confirmedDecisions.count ?? 0,
    suggested_decisions: suggestedDecisions.count ?? 0,
    attachments: attachmentIds.length,
    // Share links die with the move — disclosed, never a choice.
    shares_active: activeShares.count ?? 0,
    // Derived artifacts and the choices the move endpoint accepts
    confirmed_actions: actionSignals,
    claims: {
      sole_sourced: soleSourced.length,
      shared: shared.length,
    },
    contacts: {
      auto_created: autoCreated.map((c) => ({
        id: c.id,
        full_name: c.full_name,
        email: c.email,
      })),
      other: otherContacts.length,
    },
  })
}
