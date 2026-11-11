import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { applyOps, getTable } from '@/lib/tables/store'
import { tableRefusal } from '@/lib/tables/responses'

type Ctx = { params: Promise<{ id: string }> }

/** GET: one table with its columns. */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  try {
    const table = await getTable(supabase, workspaceId, id, { userId: user.id })
    if (!table) return notFound('Table not found')
    return NextResponse.json({ table })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the table')
  }
}

/**
 * PATCH { name?, icon?, description?, visibility? }: the table's own fields,
 * as one batch with no version check (the actions menu's Rename sends this).
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Nothing to change.')
  const op: Record<string, unknown> = { op: 'update_table' }
  for (const k of ['name', 'icon', 'description', 'visibility']) if (k in body) op[k] = body[k]
  try {
    const result = await applyOps(supabase, workspaceId, id, { baseVersion: null, ops: [op] }, { userId: user.id, source: 'person' })
    if (!result.ok) return tableRefusal(result)
    const table = await getTable(supabase, workspaceId, id, { userId: user.id })
    return NextResponse.json({ table, change_id: result.value.change_id })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not change the table')
  }
}
