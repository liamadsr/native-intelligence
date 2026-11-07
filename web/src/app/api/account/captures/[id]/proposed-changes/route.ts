import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The columns the client actually renders (ProposalCard + SmartText +
 * derive-ui + the capture panel's reconcile/sort), plus the id/status/
 * created_at/updated_at bookkeeping the reconcile-by-id watermark needs.
 *
 * This GET is polled every 25s while recording (and refetched on every
 * proposed_change realtime burst), so it must NOT ship columns nobody reads.
 * Deliberately dropped from `select('*')`: workspace_id, status_from, team_id,
 * labels, anchor_text, applied_at, applied_by — server-side apply-engine
 * concerns that no client consumer of this endpoint touches. If a card grows a
 * new field, add its column here.
 */
const PROPOSED_CHANGE_FIELDS = [
  'id',
  'capture_id',
  'change_type',
  'entity_type',
  'entity_id',
  'display_text',
  'title',
  'description',
  'priority',
  'due_date',
  'status_to',
  'assignee_name',
  'assignee_member_id',
  'assignee_contact_id',
  'project_id',
  'email_to_name',
  'email_to_address',
  'email_subject',
  'email_context',
  'extra',
  'sort_order',
  'confidence',
  'trigger_quote',
  'reasoning',
  'stakes',
  'open_questions',
  'status',
  'auto_accepted',
  'result_entity_id',
  'error_message',
  'created_at',
  'updated_at',
].join(', ')

/**
 * GET /api/account/captures/[id]/proposed-changes
 * Returns all proposed changes for a capture with status counts.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  const { data, error } = await supabase
    .from('proposed_change')
    .select(PROPOSED_CHANGE_FIELDS)
    .eq('capture_id', id)
    .eq('workspace_id', workspaceId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) return serverError(error.message)

  // The dynamic select string defeats supabase-js row inference — the rows
  // are plain proposed_change records; only `status` is read server-side.
  const changes = (data || []) as unknown as { status: string }[]
  const counts = {
    pending: 0,
    applied: 0,
    dismissed: 0,
    total: changes.length,
  }
  for (const c of changes) {
    if (c.status === 'pending') counts.pending++
    else if (c.status === 'applied') counts.applied++
    else if (c.status === 'dismissed') counts.dismissed++
  }

  return NextResponse.json({ changes, counts })
}
