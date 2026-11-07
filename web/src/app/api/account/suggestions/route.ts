import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { annotateDrift, type DriftRow } from '@/lib/suggestions/drift'
import { expireSuggestion } from '@/lib/suggestions/settle'

/**
 * The columns a suggestion card renders (ProposalCard, SmartText, derive-ui),
 * plus where it lives and its lifecycle. Same set as the capture route's
 * PROPOSED_CHANGE_FIELDS, plus the home, workspace and lifecycle columns.
 */
const SUGGESTION_FIELDS = [
  'id', 'workspace_id', 'capture_id', 'document_id', 'conversation_id', 'tracked_job_id', 'origin',
  'change_type', 'entity_type', 'entity_id', 'display_text', 'title', 'description', 'priority',
  'due_date', 'status_from', 'status_to', 'assignee_name', 'assignee_member_id', 'assignee_contact_id',
  'team_id', 'project_id', 'email_to_name', 'email_to_address', 'email_subject', 'email_context',
  'extra', 'sort_order', 'confidence', 'trigger_quote', 'reasoning', 'stakes', 'open_questions',
  'status', 'auto_accepted', 'result_entity_id', 'error_message', 'base', 'expires_at', 'expire_reason',
  'resolved_at', 'applied_by', 'created_at', 'updated_at',
].join(', ')

const MAX_IDS = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/account/suggestions — suggestions the person can see, by
 * `?ids=a,b`, or by home: `?document_id=`, `?conversation_id=`, `?capture_id=`.
 * RLS decides visibility (migration 312), so this works across workspaces.
 *
 * Each pending suggestion about an existing action is checked against the
 * action as it is now (drift.ts). One whose change already holds, or whose
 * action is gone, is expired here and comes back that way, so a brief opened
 * days later shows "Already done" instead of a stale Accept. One whose target
 * someone else changed carries `drift` for the card to warn with.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase } = auth
  const sp = request.nextUrl.searchParams

  let q = supabase.from('proposed_change').select(SUGGESTION_FIELDS)
  const idsParam = sp.get('ids')
  if (idsParam) {
    const ids = idsParam.split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s))
    if (ids.length === 0) return badRequest('ids must be uuids')
    if (ids.length > MAX_IDS) return badRequest(`At most ${MAX_IDS} ids`)
    q = q.in('id', ids)
  } else {
    const home = (['document_id', 'conversation_id', 'capture_id'] as const).find((k) => sp.get(k))
    if (!home) return badRequest('Pass ids, document_id, conversation_id or capture_id')
    const value = sp.get(home)!
    if (!UUID_RE.test(value)) return badRequest(`${home} must be a uuid`)
    q = q.eq(home, value)
  }

  const { data, error } = await q.order('sort_order', { ascending: true }).order('created_at', { ascending: true })
  if (error) return serverError(error.message)
  const rows = (data ?? []) as unknown as Array<DriftRow & Record<string, unknown>>

  const drift = await annotateDrift(supabase, rows)
  const suggestions = await Promise.all(
    rows.map(async (row) => {
      const d = drift.get(row.id)
      if (d && (d.kind === 'already_true' || d.kind === 'target_deleted')) {
        // Best-effort and guarded on pending: a concurrent accept wins.
        if (await expireSuggestion(supabase, row.id, d.kind)) {
          return { ...row, status: 'expired', expire_reason: d.kind }
        }
        return row
      }
      return d && d.kind === 'changed' ? { ...row, drift: d.fields } : row
    }),
  )

  const counts = { pending: 0, applied: 0, dismissed: 0, expired: 0, total: suggestions.length }
  for (const s of suggestions) {
    const st = s.status as keyof typeof counts
    if (st in counts && st !== 'total') counts[st]++
  }
  return NextResponse.json({ suggestions, counts })
}
