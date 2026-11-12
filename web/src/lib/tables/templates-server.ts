/**
 * A starter table made (Tables, phase 6): its columns and example rows in
 * the one batch that makes the table (store.ts createTable: one change, the
 * table's first), then its views, workspace-wide for a workspace table and
 * the owner's own for a private one. A view that can't be saved is left out:
 * the table is there either way, and the views system draws a grid.
 *
 * SERVER ONLY.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTable, type TableActor, type TableWrite } from './store'
import { tableTemplate, templateViewRow, type TemplateId } from './templates'
import type { ApplyResult, DataTableVisibility } from './types'

export async function createFromTemplate(
  db: SupabaseClient,
  workspaceId: string,
  templateId: TemplateId,
  opts: { name?: string; visibility?: DataTableVisibility; userId: string },
  actor: TableActor,
): Promise<TableWrite<ApplyResult & { table_id: string; views: number }>> {
  const t = tableTemplate(templateId)
  const made = await createTable(
    db,
    workspaceId,
    {
      name: opts.name?.trim() || t.name,
      visibility: opts.visibility,
      icon: t.icon,
      description: t.description,
      columns: t.columns,
      rows: t.rows,
    },
    actor,
  )
  if (!made.ok) return made
  const tableId = made.value.table_id
  const visibility = opts.visibility === 'private' ? 'personal' : 'workspace'
  const rows = t.views.map((v) => {
    const shape = templateViewRow(v)
    return {
      workspace_id: workspaceId,
      created_by: opts.userId,
      name: shape.name,
      entity_type: 'data_row',
      visibility,
      layout: shape.layout,
      filters: shape.filters,
      grouping: shape.grouping,
      ordering: shape.ordering,
      display_properties: [],
      board_group_by: null,
      show_completed: true,
      completed_filter: 'all',
      show_sub_items: true,
      nested_sub_items: false,
      show_empty_groups: shape.layout === 'board',
      scope_type: 'data_table',
      scope_id: tableId,
      metadata: shape.metadata,
    }
  })
  const { data, error } = await db.from('view').insert(rows).select('id')
  if (error) console.warn('[tables] template views not saved:', error.message)
  return { ok: true, value: { ...made.value, views: error ? 0 : (data ?? []).length } }
}
