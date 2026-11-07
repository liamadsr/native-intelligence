/**
 * The Agents page's entity chips (row 10): for each listed work item, the
 * entities it touched, named from each entity's own row in the item's
 * workspace; an entity the caller cannot read has no label and no chip; a
 * failed read is no chips, never a failed page.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { loadWorkItemChips } from '../work-item-chips'

describe('loadWorkItemChips', () => {
  it('names each item’s chips from the entity’s own row, in the item’s workspace', async () => {
    const fake = makeFakeSupabase()
    fake.seed('work_touch', [
      { work_item_id: 'j1', entity_type: 'contact', entity_id: 'c1', verb: 'read', at: '2026-09-27T09:00:00Z' },
      { work_item_id: 'j1', entity_type: 'action', entity_id: 'a1', verb: 'wrote', at: '2026-09-27T09:01:00Z' },
      { work_item_id: 'j1', entity_type: 'document', entity_id: 'hidden-doc', verb: 'created', at: '2026-09-27T09:02:00Z' },
      { work_item_id: 'j2', entity_type: 'company', entity_id: 'co1', verb: 'read', at: '2026-09-27T09:00:00Z' },
      { work_item_id: 'not-listed', entity_type: 'contact', entity_id: 'c1', verb: 'read', at: '2026-09-27T09:00:00Z' },
    ])
    fake.seed('contact', [{ id: 'c1', workspace_id: 'w1', full_name: 'Dana Lee' }])
    fake.seed('actions', [{ id: 'a1', workspace_id: 'w1', title: 'Send the SOW' }])
    fake.seed('company', [{ id: 'co1', workspace_id: 'w2', name: 'Northwind' }])
    const chips = await loadWorkItemChips(fake as never, [
      { id: 'j1', workspace_id: 'w1' },
      { id: 'j2', workspace_id: 'w2' },
    ])
    expect(chips).toEqual({
      j1: [
        { entity_type: 'action', entity_id: 'a1', wrote: true, label: 'Send the SOW' },
        { entity_type: 'contact', entity_id: 'c1', wrote: false, label: 'Dana Lee' },
      ],
      j2: [{ entity_type: 'company', entity_id: 'co1', wrote: false, label: 'Northwind' }],
    })
  })

  it('no items, no reads; a failed read is no chips', async () => {
    const fake = makeFakeSupabase()
    expect(await loadWorkItemChips(fake as never, [])).toEqual({})
    expect(fake.calls).toEqual([])
    const broken = { from: () => { throw new Error('boom') } }
    expect(await loadWorkItemChips(broken as never, [{ id: 'j1', workspace_id: 'w1' }])).toEqual({})
  })
})
