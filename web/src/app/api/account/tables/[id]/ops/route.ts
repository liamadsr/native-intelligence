import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
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
  const result = await applyOps(
    supabase,
    workspaceId,
    id,
    { baseVersion: base, ops: body.ops },
    { userId: user.id, source: 'person', reason: typeof body.reason === 'string' ? body.reason : null },
  )
  if (!result.ok) return tableRefusal(result)
  return NextResponse.json(result.value)
}
