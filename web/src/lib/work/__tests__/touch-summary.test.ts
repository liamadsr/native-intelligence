/**
 * How an entity's agent activity reads (row 10): one group per work item with
 * its verbs counted, reads apart from writes, and the Agents page's chips.
 */
import { describe, it, expect } from 'vitest'
import { addTouch, groupTouches, isReadOnly, pickEntityChips, summarizeVerbs } from '../touch-summary'

const t = (work_item_id: string, verb: string, at: string, tool_name: string | null = null) => ({ work_item_id, verb, at, tool_name })

describe('groupTouches', () => {
  it('one group per work item, newest first, verbs counted, the writers’ own stamps left out of tools', () => {
    const groups = groupTouches([
      t('a', 'read', '2026-09-27T10:00:00Z', 'get_action'),
      t('b', 'created', '2026-09-27T12:00:00Z', 'create_document'),
      t('a', 'wrote', '2026-09-27T11:00:00Z', 'update_action'),
      t('a', 'read', '2026-09-27T09:00:00Z', 'declared'),
      t('b', 'delivered', '2026-09-27T12:01:00Z', 'finish'),
      t('c', 'bogus', '2026-09-27T13:00:00Z', 'x'),
    ])
    expect(groups.map((g) => g.work_item_id)).toEqual(['b', 'a'])
    expect(groups[0]).toEqual({ work_item_id: 'b', verbs: { delivered: 1, created: 1 }, tools: ['create_document'], last_at: '2026-09-27T12:01:00Z' })
    expect(groups[1]).toEqual({ work_item_id: 'a', verbs: { wrote: 1, read: 2 }, tools: ['update_action', 'get_action'], last_at: '2026-09-27T11:00:00Z' })
  })

  it('addTouch counts one more and moves the time forward, never back', () => {
    const [g] = groupTouches([t('a', 'read', '2026-09-27T10:00:00Z', 'get_action')])
    const later = addTouch(g, t('a', 'wrote', '2026-09-27T11:00:00Z', 'update_action'))
    expect(later).toMatchObject({ verbs: { read: 1, wrote: 1 }, tools: ['update_action', 'get_action'], last_at: '2026-09-27T11:00:00Z' })
    expect(addTouch(later, t('a', 'read', '2026-09-27T09:00:00Z')).last_at).toBe('2026-09-27T11:00:00Z')
  })
})

describe('reads and writes', () => {
  it('a row of reads is "looked at"; writes lead the summary', () => {
    expect(isReadOnly({ read: 3 })).toBe(true)
    expect(isReadOnly({ read: 3, wrote: 1 })).toBe(false)
    expect(summarizeVerbs({ read: 1 })).toBe('looked at')
    expect(summarizeVerbs({ created: 1 })).toBe('created')
    expect(summarizeVerbs({ read: 3, wrote: 1, created: 2 })).toBe('created 2 · wrote 1 · read 3')
  })
})

describe('pickEntityChips', () => {
  const e = (work_item_id: string, entity_type: string, entity_id: string, verb: string, at: string) => ({ work_item_id, entity_type, entity_id, verb, at })
  it('per item: changed entities first, then read ones, newest first, at most three, only kinds a chip can open', () => {
    const chips = pickEntityChips([
      e('w', 'contact', 'c1', 'read', '2026-09-27T10:00:00Z'),
      e('w', 'capture', 'k1', 'read', '2026-09-27T12:00:00Z'),
      e('w', 'document', 'd1', 'created', '2026-09-27T09:00:00Z'),
      e('w', 'contact', 'c1', 'wrote', '2026-09-27T08:00:00Z'),
      e('w', 'proposal', 'p1', 'proposed', '2026-09-27T13:00:00Z'),
      e('w', 'action', 'a1', 'read', '2026-09-27T07:00:00Z'),
      e('x', 'project', 'pr1', 'read', '2026-09-27T07:00:00Z'),
    ])
    expect(chips.get('w')).toEqual([
      { entity_type: 'contact', entity_id: 'c1', wrote: true },
      { entity_type: 'document', entity_id: 'd1', wrote: true },
      { entity_type: 'capture', entity_id: 'k1', wrote: false },
    ])
    expect(chips.get('x')).toEqual([{ entity_type: 'project', entity_id: 'pr1', wrote: false }])
  })
})
