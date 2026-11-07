import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import {
  LIVE_DIRECTIVE_ROW_COLUMNS,
  checkDirectiveTarget,
  insertDirective,
  type LiveDirectiveRow,
} from '@/lib/live-agent/directives'

/**
 * /api/account/captures/[id]/directives — what the user tells the note-taker to
 * record during a live meeting (docs/plans/live-agent-messaging.md, L2).
 *
 * POST { text }: a typed `@notes …` in the meeting chat. No model call and no
 * talk-back reply (decision 2): the directive is written and the chat shows it
 * as a row that turns "Noted" when the next record-writing turn consumes it
 * (L1). Only the capture's owner, only until the end-of-meeting pass has
 * written the record. 201 with the row.
 *
 * GET: the caller's own directives on the capture, oldest first, for the
 * acknowledgement rows to start from (realtime keeps them current).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id: captureId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const text = (body as { text?: unknown } | null)?.text
  if (typeof text !== 'string') return badRequest('text is required')

  const target = await checkDirectiveTarget(supabase, { captureId, workspaceId, userId: user.id })
  if (!target.ok) {
    if (target.reason === 'not_owner') return forbidden(target.message)
    if (target.reason === 'closed') return apiError(target.message, { status: 409, code: 'CAPTURE_CLOSED' })
    return serverError(target.message)
  }

  const result = await insertDirective(getServiceClient(), {
    captureId,
    workspaceId,
    userId: user.id,
    source: 'user',
    text,
  })
  if (!result.ok) {
    if (result.reason === 'empty' || result.reason === 'too_long') return badRequest(result.message)
    if (result.reason === 'cap') return apiError(result.message, { status: 429, code: 'DIRECTIVE_CAP' })
    return serverError(result.message)
  }
  return NextResponse.json({ directive: result.directive }, { status: 201 })
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id: captureId } = await params

  // RLS already limits a user session to its own rows; the explicit author and
  // workspace fences hold for a service-role client (a desktop device token).
  const { data, error } = await supabase
    .from('live_directive')
    .select(LIVE_DIRECTIVE_ROW_COLUMNS)
    .eq('capture_id', captureId)
    .eq('workspace_id', workspaceId)
    .eq('created_by', user.id)
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) return serverError(error.message)
  return NextResponse.json({ directives: (data ?? []) as unknown as LiveDirectiveRow[] })
}
