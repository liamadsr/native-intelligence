/**
 * GET /api/account/documents/[id]/move/preflight
 *
 * What a cross-workspace move of this document would cost, for the move
 * dialog's disclosure:
 *
 *   - `shares_active` — live public share links. The move deactivates them in
 *     place (the share row and its external commenters stay in the source
 *     workspace), so anyone holding the URL loses access.
 *   - `drafts_by_others` — unpublished drafts by other members, discarded by
 *     the move. The caller's own draft travels.
 *   - `comments` — comments on the document; they travel, with authors
 *     translated to the matching member in the destination where one exists.
 *   - `claims` — knowledge claims solely evidenced by this document (they
 *     move when `move_claims` stays on) vs claims with evidence elsewhere
 *     (always stay behind).
 *
 * No destination_workspace_id is needed — the counts don't depend on where
 * the document lands (the destination only matters for permission checks,
 * enforced at move time).
 *
 * Scoped to the caller's CURRENT workspace so a user with several
 * memberships can't probe documents outside the one they're viewing.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import {
  partitionClaimsForSources,
  type ClaimSourceRow,
} from '@/lib/workspace-move/artifacts'
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

/** `.in()` serializes into the query string; chunk id lists so a heavily
 * cited document can't overflow the URL (see the mig-192 outage). */
const IN_CHUNK = 100

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  const { id: documentId } = await params

  // Belt-and-suspenders: RLS already filters documents by workspace
  // membership, but we additionally pin to the caller's current workspace.
  const { data: document, error: documentErr } = await supabase
    .from('document')
    .select('id, workspace_id')
    .eq('id', documentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (documentErr) {
    console.error('[document_move_preflight] document lookup failed:', documentErr.message)
    return serverError('Preflight failed')
  }
  if (!document) return notFound('Document not found')

  const round1 = await Promise.all([
    supabase
      .from('share')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('shareable_type', 'document')
      .eq('shareable_id', documentId)
      .eq('is_active', true),
    // document_draft is RLS-scoped to its author (migration 110), so the
    // user client can't see other members' drafts — exactly the ones this
    // disclosure exists to warn about. Count (never read) them with the
    // service client, pinned to the workspace-checked document id.
    getServiceClient()
      .from('document_draft')
      .select('author_id', { count: 'exact', head: true })
      .eq('document_id', documentId)
      .neq('author_id', member.id),
    supabase
      .from('comment')
      .select('id', { count: 'exact', head: true })
      .eq('commentable_type', 'document')
      .eq('commentable_id', documentId),
    supabase
      .from('claim_source')
      .select('claim_id')
      .eq('source_type', 'document')
      .eq('source_id', documentId),
  ])

  const round1Error = firstError(round1)
  if (round1Error) {
    console.error('[document_move_preflight] count query failed:', round1Error)
    return serverError('Preflight failed')
  }

  const [sharesRes, draftsRes, commentsRes, claimSourcesRes] = round1

  const linkedClaimIds = [
    ...new Set(
      ((claimSourcesRes.data ?? []) as { claim_id: string }[]).map((r) => r.claim_id),
    ),
  ]

  // Round 2 — scope the linked claims to this workspace (claim_source has no
  // workspace of its own), then load ALL their evidence rows so the
  // sole-vs-shared partition sees sources beyond this document.
  let claimIds: string[] = []
  let claimSourceRows: ClaimSourceRow[] = []
  if (linkedClaimIds.length > 0) {
    const claimBatches = await Promise.all(
      chunk(linkedClaimIds, IN_CHUNK).map((ids) =>
        supabase
          .from('claim')
          .select('id')
          .eq('workspace_id', workspaceId)
          .in('id', ids),
      ),
    )
    const claimError = firstError(claimBatches)
    if (claimError) {
      console.error('[document_move_preflight] claim query failed:', claimError)
      return serverError('Preflight failed')
    }
    claimIds = claimBatches.flatMap(
      (b) => ((b.data ?? []) as { id: string }[]).map((c) => c.id),
    )

    if (claimIds.length > 0) {
      const sourceBatches = await Promise.all(
        chunk(claimIds, IN_CHUNK).map((ids) =>
          supabase
            .from('claim_source')
            .select('claim_id, source_type, source_id')
            .in('claim_id', ids),
        ),
      )
      const sourceError = firstError(sourceBatches)
      if (sourceError) {
        console.error('[document_move_preflight] claim_source query failed:', sourceError)
        return serverError('Preflight failed')
      }
      claimSourceRows = sourceBatches.flatMap(
        (b) => (b.data ?? []) as ClaimSourceRow[],
      )
    }
  }

  const { soleSourced, shared } = partitionClaimsForSources(claimIds, claimSourceRows, [
    { type: 'document', id: documentId },
  ])

  return NextResponse.json({
    document_id: documentId,
    shares_active: sharesRes.count ?? 0,
    drafts_by_others: draftsRes.count ?? 0,
    comments: commentsRes.count ?? 0,
    claims: {
      sole_sourced: soleSourced.length,
      shared: shared.length,
    },
  })
}
