/**
 * /api/account/prospecting/entries/[id] — one entry, and its stage.
 *
 * PATCH takes `{stage, dismissed_reason}`. It cannot set `stage='saved'` —
 * that is what `entries/save` does, and it means "a CRM record exists", so a
 * PATCH claiming it would make the stage lie about the CRM.
 *
 * Dismiss never touches the CRM: the entry persists so it keeps suppressing,
 * and with reason `competitor` or `already_customer` it suppresses in every
 * list in the workspace (decision 3).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { updateEntryStage } from '@/lib/prospecting/lists'
import type { ProspectListEntryRow } from '@/lib/prospecting/types'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const { data, error } = await supabase
    .from('prospect_list_entry')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] entry load failed:', error.message)
    return serverError()
  }
  if (!data) return notFound('Entry not found')
  return NextResponse.json({ entry: data as unknown as ProspectListEntryRow })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  if (typeof body.stage !== 'string') return badRequest('stage is required')

  const result = await updateEntryStage(supabase, {
    workspaceId,
    entryId: id,
    userId: user.id,
    stage: body.stage,
    dismissedReason: body.dismissed_reason,
  })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('Entry not found')
    if (result.code === 'INVALID_INPUT') return badRequest(result.error)
    return serverError()
  }
  return NextResponse.json({ entry: result.entry })
}
