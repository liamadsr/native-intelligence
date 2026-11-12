import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/tables/ops'

/**
 * GET: which table a row is in, and whether that table is a pipeline (its
 * rows are deals): what a mention or a link of a row opens on. RLS decides
 * whether the person reads it.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Row not found' }, { status: 404 })
  try {
    const { data, error } = await supabase
      .from('data_row')
      .select('id, title, table_id, data_table!inner(kind)')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const row = data as { id: string; title: string; table_id: string; data_table: { kind?: string } | Array<{ kind?: string }> } | null
    if (!row) return NextResponse.json({ error: 'Row not found' }, { status: 404 })
    const table = Array.isArray(row.data_table) ? row.data_table[0] : row.data_table
    return NextResponse.json({ id: row.id, title: row.title, table_id: row.table_id, kind: table?.kind ?? 'table' })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read the row')
  }
}
