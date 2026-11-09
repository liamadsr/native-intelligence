/**
 * The deals board's columns (roadmap #8): one per stage of ONE pipeline, empty
 * ones included, in the pipeline's order, each labelled with the stage's
 * name and carrying its kind (open / won / lost) for the column header.
 *
 * Deals in another pipeline's stage (a board with no pipeline filter, when a
 * workspace has several) keep their own columns after the board pipeline's,
 * in their pipeline's order, so nothing on the board disappears.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GroupedResults } from '@/lib/views/types'
import { listPipelines, type DealPipeline } from './deals'

export function arrangeStageColumns(
  pipelines: readonly DealPipeline[],
  boardPipelineId: string | null,
  grouped: readonly GroupedResults[],
  direction: 'asc' | 'desc' = 'asc',
): GroupedResults[] {
  const board = pipelines.find((p) => p.id === boardPipelineId) ?? pipelines.find((p) => p.is_default) ?? pipelines[0]
  const byKey = new Map(grouped.map((g) => [g.key, g]))
  const out: GroupedResults[] = []
  const placed = new Set<string>()

  const ordered = board ? [board, ...pipelines.filter((p) => p.id !== board.id)] : [...pipelines]
  for (const pipeline of ordered) {
    const stages = direction === 'desc' ? [...pipeline.stages].reverse() : pipeline.stages
    for (const stage of stages) {
      const existing = byKey.get(stage.id)
      // Another pipeline's stage shows only when a deal sits in it.
      if (pipeline !== board && !existing) continue
      out.push({
        ...(existing ?? { items: [] }),
        key: stage.id,
        label: pipeline === board ? stage.name : `${stage.name} · ${pipeline.name}`,
        items: existing?.items ?? [],
        metadata: { ...(existing?.metadata ?? {}), stage_kind: stage.kind, pipeline_id: pipeline.id, position: stage.position },
      })
      placed.add(stage.id)
    }
  }
  // Anything left (a deal whose stage was just deleted): last, as it came.
  for (const g of grouped) if (!placed.has(g.key)) out.push(g)
  return out
}

export async function pipelineBoardColumns(
  db: SupabaseClient,
  workspaceId: string,
  boardPipelineId: string | null,
  grouped: readonly GroupedResults[],
  direction: 'asc' | 'desc' = 'asc',
): Promise<GroupedResults[]> {
  const pipelines = await listPipelines(db, workspaceId)
  return arrangeStageColumns(pipelines, boardPipelineId, grouped, direction)
}
