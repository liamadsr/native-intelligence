/**
 * A form on a pipeline (../pipeline.ts): the deal's stage is the first open
 * one and never a stranger's, the Stage column is no form's to fill, and
 * the keys here are the pipeline's own (src/lib/crm/deals.ts).
 */
import { describe, expect, it } from 'vitest'
import { PIPELINE_KEYS } from '@/lib/crm/deals'
import type { DataColumn } from '@/lib/tables/types'
import { validateFormFields } from '../fields'
import { firstOpenStage, formDealValues, PIPELINE_OWNER_KEY, pipelineFormRefusal, pipelineStageColumn } from '../pipeline'
import { formShape } from '../public'
import { FORM_TITLE_KEY, isFormColumn, PIPELINE_STAGE_KEY, type DataForm } from '../types'

const col = (key: string, label: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `col-${key}`,
  table_id: 'p1',
  key,
  label,
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})
const STAGE = col('stage', 'Stage', 'select', { options: ['Lost', 'Lead', 'Won'], config: { outcomes: { Lost: 'lost', Won: 'won' } }, system: true })
const COLUMNS = [STAGE, col('value', 'Value', 'currency', { system: true }), col('expected_close', 'Expected close', 'date', { system: true }), col('owner', 'Owner', 'person', { system: true }), col('tier', 'Tier', 'select', { options: ['A', 'B'] })]

describe("a pipeline's keys", () => {
  it('are the deals code\'s own', () => {
    expect(PIPELINE_STAGE_KEY).toBe(PIPELINE_KEYS.stage)
    expect(PIPELINE_OWNER_KEY).toBe(PIPELINE_KEYS.owner)
  })
})

describe('the stage a form deal starts in', () => {
  it('is the first OPEN stage, past a won or lost one listed first', () => {
    expect(firstOpenStage(COLUMNS)).toBe('Lead')
  })

  it('is none when every stage closes, or the table is not a pipeline', () => {
    expect(firstOpenStage([{ ...STAGE, options: ['Won'], config: { outcomes: { Won: 'won' } } }])).toBeNull()
    expect(firstOpenStage([{ ...STAGE, system: false }])).toBeNull()
    expect(pipelineStageColumn([{ ...STAGE, system: false }])).toBeNull()
  })

  it("overrides any stage the values carry, and sets the owner only on a pipeline's own Owner column", () => {
    expect(formDealValues(COLUMNS, { stage: 'Won', value: null }, 'm-1')).toEqual({ stage: 'Lead', value: null, owner: 'm-1' })
    expect(formDealValues([STAGE], { stage: 'Won' }, 'm-1')).toEqual({ stage: 'Lead' })
    expect(formDealValues([{ ...STAGE, system: false }], { stage: 'Won' }, 'm-1')).toEqual({ stage: 'Won' })
  })
})

describe('what a form may fill on a pipeline', () => {
  it('never its Stage, nor any system choice; its plain Value and close date, and the people\'s own selects, yes', () => {
    expect(isFormColumn(STAGE)).toBe(false)
    expect(isFormColumn(col('kind', 'Kind', 'select', { system: true }))).toBe(false)
    expect(isFormColumn(col('value', 'Value', 'currency', { system: true }))).toBe(true)
    expect(isFormColumn(col('expected_close', 'Expected close', 'date', { system: true }))).toBe(true)
    expect(isFormColumn(col('tier', 'Tier', 'select'))).toBe(true)
    expect(isFormColumn(col('owner', 'Owner', 'person', { system: true }))).toBe(false)
    // A table's own column keyed "stage" (not a pipeline's) is a plain select.
    expect(isFormColumn(col('stage', 'Stage', 'select'))).toBe(true)
  })

  it('is refused when saved, and its page never draws it', () => {
    const out = validateFormFields(COLUMNS, [{ key: FORM_TITLE_KEY }, { key: 'stage' }])
    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain("Stage can't be on a form")
    const form = { name: 'Leads', description: null, submitLabel: null, thanks: null, botCheck: true, access: 'public', fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: true }, { key: 'stage', label: 'Stage', required: false }, { key: 'value', label: 'Budget', required: false }] } as unknown as DataForm
    expect(formShape(form, COLUMNS).fields.map((f) => f.name)).toEqual(['name', 'value'])
  })

  it("needs what its first open stage needs, asked as required; a later stage's rule is not its own", () => {
    const needs = COLUMNS.map((c) => (c.key === 'value' ? { ...c, config: { required_when: { key: 'stage', option: 'Lead' } } } : c))
    expect(pipelineFormRefusal(needs, [{ key: 'value', label: 'Budget', required: false }])).toContain('needs Value')
    expect(pipelineFormRefusal(needs, [{ key: 'value', label: 'Budget', required: true }])).toBeNull()
    const later = COLUMNS.map((c) => (c.key === 'value' ? { ...c, config: { required_when: { key: 'stage', option: 'Won' } } } : c))
    expect(pipelineFormRefusal(later, [])).toBeNull()
    // The owner it needs is the form's maker, set server-side.
    const owner = COLUMNS.map((c) => (c.key === 'owner' ? { ...c, config: { required_when: { key: 'stage', option: 'Lead' } } } : c))
    expect(pipelineFormRefusal(owner, [])).toBeNull()
    // A company it needs can't come from a form at all.
    const company = [...COLUMNS, col('company', 'Company', 'relation', { system: true, config: { target: { kind: 'company' }, required_when: { key: 'stage', option: 'Lead' } } })]
    expect(pipelineFormRefusal(company, [])).toContain("a form can't fill it")
  })
})
