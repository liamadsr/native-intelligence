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
import { createPipeline } from '@/lib/crm/deals'
import { applyOps, createTable, listColumns, type TableActor, type TableWrite } from './store'
import { tableTemplate, templateViewRow, type TableTemplate, type TemplateId } from './templates'
import type { ApplyResult, DataTableVisibility } from './types'

/**
 * The Pipeline starter (Tables, phase 7): a real pipeline (create_pipeline:
 * its stages and own columns), then the starter's other columns and example
 * rows in one batch. A pipeline is open to the workspace (`private` asked:
 * made private in that batch, as it is not the default).
 */
async function createPipelineFromTemplate(
  db: SupabaseClient,
  workspaceId: string,
  t: TableTemplate,
  opts: { name?: string; visibility?: DataTableVisibility },
  actor: TableActor,
): Promise<TableWrite<ApplyResult & { table_id: string }>> {
  const stages = t.columns.find((c) => c.key === 'stage')?.options?.map((name) => ({ name, outcome: name === 'Won' ? ('won' as const) : name === 'Lost' ? ('lost' as const) : ('open' as const) }))
  const made = await createPipeline(db, workspaceId, { name: opts.name?.trim() || t.name, stages }, { userId: actor.userId, source: actor.source === 'import' ? 'person' : actor.source, asUserId: actor.asUserId ?? null, reason: actor.reason ?? null })
  if (!made.ok) return { ok: false, reason: 'invalid', error: made.error }
  const own = new Set((await listColumns(db, workspaceId, made.id)).map((c) => c.key))
  const ops = [
    ...(opts.visibility === 'private' ? [{ op: 'update_table', visibility: 'private' }] : []),
    ...t.columns.filter((c) => !own.has(c.key)).map((c) => ({ op: 'create_column', ...c })),
    ...(t.rows.length ? [{ op: 'insert_rows', rows: t.rows }] : []),
  ]
  const filled = await applyOps(db, workspaceId, made.id, { baseVersion: null, ops }, actor)
  if (!filled.ok) return filled
  return { ok: true, value: { ...filled.value, table_id: made.id } }
}

export async function createFromTemplate(
  db: SupabaseClient,
  workspaceId: string,
  templateId: TemplateId,
  opts: { name?: string; visibility?: DataTableVisibility; userId: string },
  actor: TableActor,
): Promise<TableWrite<ApplyResult & { table_id: string; views: number }>> {
  const t = tableTemplate(templateId)
  const made = t.pipeline
    ? await createPipelineFromTemplate(db, workspaceId, t, opts, actor)
    : await createTable(
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
  let views = 0
  try {
    const { data, error } = await db.from('view').insert(rows).select('id')
    if (error) console.warn('[tables] template views not saved:', error.message)
    else views = (data ?? []).length
  } catch (err) {
    console.warn('[tables] template views not saved:', err instanceof Error ? err.message : 'unknown')
  }
  return { ok: true, value: { ...made.value, views } }
}
