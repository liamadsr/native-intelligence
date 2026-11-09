import { describe, it, expect } from 'vitest'
import { arrangeStageColumns } from '../deal-board'
import type { DealPipeline } from '../deals'

const pipeline = (id: string, name: string, isDefault: boolean, stages: Array<[string, string, 'open' | 'won' | 'lost']>): DealPipeline => ({
  id,
  name,
  is_default: isDefault,
  position: isDefault ? 0 : 1,
  stages: stages.map(([sid, sname, kind], i) => ({ id: sid, pipeline_id: id, name: sname, position: i, kind, color: null })),
})

const sales = pipeline('p1', 'Sales', true, [['lead', 'Lead', 'open'], ['prop', 'Proposal', 'open'], ['won', 'Won', 'won'], ['lost', 'Lost', 'lost']])
const partners = pipeline('p2', 'Partners', false, [['intro', 'Intro', 'open'], ['signed', 'Signed', 'won']])

describe('deals board columns', () => {
  it('shows every stage of the default pipeline in order, empty ones included', () => {
    const cols = arrangeStageColumns([sales], null, [{ key: 'won', label: 'won', items: [{ id: 'd1' }] }])
    expect(cols.map((c) => c.key)).toEqual(['lead', 'prop', 'won', 'lost'])
    expect(cols.map((c) => c.label)).toEqual(['Lead', 'Proposal', 'Won', 'Lost'])
    expect(cols[2].items).toEqual([{ id: 'd1' }])
    expect(cols[2].metadata).toMatchObject({ stage_kind: 'won', pipeline_id: 'p1' })
  })

  it("keeps another pipeline's deals, after the board's, only where it has some", () => {
    const cols = arrangeStageColumns([sales, partners], null, [{ key: 'signed', label: 'signed', items: [{ id: 'd2' }] }])
    expect(cols.map((c) => c.key)).toEqual(['lead', 'prop', 'won', 'lost', 'signed'])
    expect(cols[4].label).toBe('Signed · Partners')
  })

  it("draws a named pipeline's board, and reverses for a descending grouping", () => {
    expect(arrangeStageColumns([sales, partners], 'p2', []).map((c) => c.key)).toEqual(['intro', 'signed'])
    expect(arrangeStageColumns([sales], null, [], 'desc').map((c) => c.key)).toEqual(['lost', 'won', 'prop', 'lead'])
  })

  it('keeps a group whose stage is gone, last', () => {
    const cols = arrangeStageColumns([sales], null, [{ key: '__none__', label: 'No stage', items: [{ id: 'x' }] }])
    expect(cols.at(-1)?.key).toBe('__none__')
  })
})
