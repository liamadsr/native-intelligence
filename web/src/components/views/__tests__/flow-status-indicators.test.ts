import { describe, it, expect } from 'vitest'
import { statusIdsForGroup } from '../group-status-ids'
import { flowsForStatusIds, type FlowStatusMap } from '../hooks/use-flow-status-ids'
import type { GroupedResults } from '@/lib/views/types'

function group(over: Partial<GroupedResults>): GroupedResults {
  return { key: 'started::In Progress', label: 'In Progress', items: [], ...over }
}

describe('statusIdsForGroup', () => {
  it('prefers metadata.status_ids (cross-team merged column)', () => {
    const g = group({ metadata: { status_ids: ['s1', 's2'], status_id: 's1' } })
    expect(statusIdsForGroup(g)).toEqual(['s1', 's2'])
  })

  it('falls back to scalar metadata.status_id', () => {
    const g = group({ metadata: { status_id: 's9' } })
    expect(statusIdsForGroup(g)).toEqual(['s9'])
  })

  it('falls back to sampling workflow_state ids off items (de-duped)', () => {
    const g = group({
      metadata: {},
      items: [
        { id: 'a', workflow_state: { id: 's3' } },
        { id: 'b', workflow_state: { id: 's3' } },
        { id: 'c', workflow_state: { id: 's4' } },
        { id: 'd' }, // no workflow_state — skipped
      ],
    })
    expect(statusIdsForGroup(g)).toEqual(['s3', 's4'])
  })

  it('returns [] when nothing resolves', () => {
    expect(statusIdsForGroup(group({ metadata: {}, items: [] }))).toEqual([])
    expect(statusIdsForGroup(group({ metadata: { status_ids: [] } }))).toEqual([])
  })
})

describe('flowsForStatusIds', () => {
  const map: FlowStatusMap = new Map([
    ['s1', [{ id: 'f1', name: 'Notify agent' }]],
    ['s2', [{ id: 'f1', name: 'Notify agent' }, { id: 'f2', name: 'Log it' }]],
  ])

  it('unions flows across the column member ids', () => {
    expect(flowsForStatusIds(['s1', 's2'], map)).toEqual([
      { id: 'f1', name: 'Notify agent' },
      { id: 'f2', name: 'Log it' },
    ])
  })

  it('dedupes a flow that appears under multiple team states', () => {
    // f1 is attached to both s1 and s2 (same flow, two teams' equivalent state).
    const out = flowsForStatusIds(['s1', 's2'], map)
    expect(out.filter((f) => f.id === 'f1')).toHaveLength(1)
  })

  it('returns [] for an unmatched status id', () => {
    expect(flowsForStatusIds(['nope'], map)).toEqual([])
  })

  it('returns [] for an empty map or empty id list', () => {
    expect(flowsForStatusIds(['s1'], new Map())).toEqual([])
    expect(flowsForStatusIds([], map)).toEqual([])
  })
})
