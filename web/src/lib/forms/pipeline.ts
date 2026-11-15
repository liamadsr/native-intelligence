/**
 * A form on a pipeline (a table of deals, migration 540): each submission
 * is one new deal. What a stranger may not choose is set here, server-side,
 * never from the post:
 *
 *   the stage   the pipeline's first open stage (its Stage column's first
 *               option whose outcome is open), always. The Stage column can't
 *               be on a form (./types.ts isFormColumn), and any `stage` a
 *               post carries is never read (./fields.ts reads only the
 *               form's own fields), so this is the only way a stage is set;
 *   the owner   the form's maker, as a deal a person makes is theirs
 *               (src/lib/crm/deals.ts createDeal), when the pipeline has its
 *               Owner column; the submission's rows are written as them too.
 *
 * The first open stage's own rules (required_when: "Lead needs Value") must
 * be met by every submission, or the database refuses the row: a form on a
 * pipeline must ask each such column, as a required field
 * (pipelineFormRefusal), checked when the form is made or its fields change.
 * A rule added later makes a submission fail as any table's rule does
 * (logged, never told to the sender).
 *
 * A table is a pipeline here when it has the system Stage column: only
 * create_pipeline makes system columns (540). Pure.
 */
import { optionOutcome } from '@/lib/crm/custom-field-types'
import type { CustomFieldValue } from '@/lib/crm/custom-fields'
import type { DataColumn } from '@/lib/tables/types'
import { isFormColumn, PIPELINE_STAGE_KEY, type FormField } from './types'

/** A pipeline's Owner column's key (src/lib/crm/deals.ts PIPELINE_KEYS.owner). */
export const PIPELINE_OWNER_KEY = 'owner'

type StageColumns = readonly Pick<DataColumn, 'key' | 'label' | 'field_type' | 'options' | 'config' | 'deleted_at' | 'system'>[]

/** The pipeline's live Stage column, or null when the table is not a pipeline. */
export function pipelineStageColumn<C extends StageColumns[number]>(columns: readonly C[]): C | null {
  return columns.find((c) => c.system && c.key === PIPELINE_STAGE_KEY && c.field_type === 'select' && !c.deleted_at) ?? null
}

/** The name of the pipeline's first open stage, or null (not a pipeline, or no open stage: the deal then has none, which reads as open). */
export function firstOpenStage(columns: StageColumns): string | null {
  const stage = pipelineStageColumn(columns)
  if (!stage) return null
  return (stage.options ?? []).find((name) => optionOutcome(stage.config, name) === 'open') ?? null
}

/** Whether a deal from a form gets its owner: the pipeline has its own Owner column (a member). */
export function hasPipelineOwner(columns: readonly Pick<DataColumn, 'key' | 'field_type' | 'deleted_at' | 'system'>[]): boolean {
  return columns.some((c) => c.system && c.key === PIPELINE_OWNER_KEY && c.field_type === 'person' && !c.deleted_at)
}

/**
 * A submission's values as the deal a pipeline takes: its stage the first
 * open one, its owner `ownerMemberId` (when given and the pipeline has the
 * column). Anything else as parsed. A table that is not a pipeline: as it is.
 */
export function formDealValues(
  columns: readonly DataColumn[],
  values: Record<string, CustomFieldValue>,
  ownerMemberId: string | null = null,
): Record<string, CustomFieldValue> {
  if (!pipelineStageColumn(columns)) return values
  const out = { ...values }
  // Never a stage from the post: the first open one, or none.
  delete out[PIPELINE_STAGE_KEY]
  const stage = firstOpenStage(columns)
  if (stage) out[PIPELINE_STAGE_KEY] = stage
  if (ownerMemberId && hasPipelineOwner(columns)) out[PIPELINE_OWNER_KEY] = ownerMemberId
  return out
}

/**
 * Why a form with these fields can't take a pipeline's deals, or null: a
 * column the first open stage needs (its required_when) that the form does
 * not ask as a required field. A table that is not a pipeline: null.
 */
export function pipelineFormRefusal(columns: StageColumns, fields: readonly FormField[]): string | null {
  const stageCol = pipelineStageColumn(columns)
  const stage = firstOpenStage(columns)
  if (!stageCol || !stage) return null
  const asked = new Set(fields.filter((f) => f.required).map((f) => f.key))
  for (const col of columns) {
    const rule = col.config?.required_when
    if (!rule || col.deleted_at || rule.key !== PIPELINE_STAGE_KEY || rule.option !== stage) continue
    // The owner is set to the form's maker (formDealValues).
    if (col.system && col.key === PIPELINE_OWNER_KEY) continue
    if (asked.has(col.key)) continue
    if (!isFormColumn(col)) return `A new deal from a form starts in ${stage}, which needs ${col.label}, and a form can't fill it. Change ${stage}'s rules first.`
    return `A new deal from a form starts in ${stage}, which needs ${col.label}: add ${col.label} to the form as a required field.`
  }
  return null
}
