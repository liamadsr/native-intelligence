import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { createTable, getTable, listTables } from '@/lib/tables/store'
import { tableRefusal } from '@/lib/tables/responses'
import type { DataTableVisibility } from '@/lib/tables/types'

/** GET: the workspace's tables (?archived=1 for the archived ones). POST: a new table. Tables, phase 1. */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  try {
    const tables = await listTables(supabase, workspaceId, { archived: request.nextUrl.searchParams.get('archived') === '1' })
    return NextResponse.json({ tables })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load tables')
  }
}

/** POST { name, visibility?, icon?, description? }: it starts with a Name column and three blank rows. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('A table needs a name.')
  const result = await createTable(
    supabase,
    workspaceId,
    {
      name: typeof body.name === 'string' ? body.name : '',
      // createTable refuses anything but workspace or private.
      visibility: body.visibility === undefined ? undefined : (body.visibility as DataTableVisibility),
      icon: typeof body.icon === 'string' ? body.icon : null,
      description: typeof body.description === 'string' ? body.description : null,
    },
    { userId: user.id, source: 'person' },
  )
  if (!result.ok) return tableRefusal(result)
  const table = await getTable(supabase, workspaceId, result.value.table_id)
  return NextResponse.json({ table, version: result.value.version, change_id: result.value.change_id }, { status: 201 })
}
