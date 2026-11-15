import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { emitRecordsCreated } from '@/lib/flows/emit-record-created'
import { workspaceHasEventFlows } from '@/lib/flows/event-triggers'
import { getServiceClient } from '@/lib/supabase/service'
import { applyOps } from '@/lib/tables/store'
import { tableRefusal } from '@/lib/tables/responses'

/**
 * POST { base_version, ops, reason? }: one batch, all or nothing. A
 * base_version that is no longer the table's is a 409 with the version now
 * (details.version): read again and retry.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send { base_version, ops }.')
  const base = body.base_version
  if (typeof base !== 'number' || !Number.isInteger(base) || base < 0) return badRequest('base_version is the table version you read.')
  try {
    const result = await applyOps(
      supabase,
      workspaceId,
      id,
      { baseVersion: base, ops: body.ops },
      { userId: user.id, source: 'person', reason: typeof body.reason === 'string' ? body.reason : null },
    )
    if (!result.ok) return tableRefusal(result)
    // The record_created loops a person's own new rows may start, about five
    // minutes from now (src/lib/flows/emit-record-created.ts). Only this route
    // and a form's submission emit: an agent's write_rows, an import and a sync
    // never do. Never throws.
    if (result.value.inserted_row_ids.length) {
      try {
        if (await workspaceHasEventFlows(getServiceClient(), { workspaceId, triggerType: 'record_created', tableId: id })) {
          await emitRecordsCreated({ workspaceId, tableId: id, rowIds: result.value.inserted_row_ids, source: 'person' })
        }
      } catch (err) {
        console.error('[tables.ops] loop event not sent (non-fatal):', err instanceof Error ? err.message : 'unknown')
      }
    }
    return NextResponse.json(result.value)
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not change the table')
  }
}
