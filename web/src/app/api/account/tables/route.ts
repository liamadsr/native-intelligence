import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { createTable, getTable, listTables } from '@/lib/tables/store'
import { tableRefusal } from '@/lib/tables/responses'
import { isTemplateId } from '@/lib/tables/templates'
import { createFromTemplate } from '@/lib/tables/templates-server'
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

/**
 * POST { name, visibility?, icon?, description? }: it starts with a Name
 * column and three blank rows. With `template` (lib/tables/templates.ts), a
 * starter: its columns, example rows and views, named `name` or the starter.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('A table needs a name.')
  try {
    if (body.template !== undefined) {
      if (!isTemplateId(body.template)) return badRequest('That is not a starter table.')
      const made = await createFromTemplate(
        supabase,
        workspaceId,
        body.template,
        {
          name: typeof body.name === 'string' ? body.name : undefined,
          visibility: body.visibility === undefined ? undefined : (body.visibility as DataTableVisibility),
          userId: user.id,
        },
        { userId: user.id, source: 'person' },
      )
      if (!made.ok) return tableRefusal(made)
      const table = await getTable(supabase, workspaceId, made.value.table_id, { userId: user.id })
      return NextResponse.json({ table, version: made.value.version, change_id: made.value.change_id }, { status: 201 })
    }
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
    const table = await getTable(supabase, workspaceId, result.value.table_id, { userId: user.id })
    return NextResponse.json({ table, version: result.value.version, change_id: result.value.change_id }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not make the table')
  }
}
