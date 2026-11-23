/**
 * A list's sharing chips (docs/plans/record-sharing.md, Phase 3): how many its
 * owner shared each of their records with, in one grants read; a private record
 * the viewer reads but does not own was shared with them.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { listSharingByRecord } from '../store'
import { canvasRowChip } from '@/components/chat-cards/pages/canvases-card'

const WS = 'ws-1'
const g = (id: string, entity_id: string, entity_type = 'canvas') => ({ id, workspace_id: WS, entity_type, entity_id })

describe('listSharingByRecord', () => {
  it('counts the owner’s grants, and marks what was shared with the viewer', async () => {
    const db = memoryDb({ entity_access: [g('1', 'mine-a'), g('2', 'mine-a'), g('3', 'mine-b', 'spreadsheet'), g('4', 'theirs')] })
    const out = await listSharingByRecord(db, { workspaceId: WS, memberId: 'm-me' }, 'canvas', [
      { id: 'mine-a', owner: 'm-me', visibility: 'private' },
      { id: 'mine-b', owner: 'm-me', visibility: 'workspace' },
      { id: 'theirs', owner: 'm-other', visibility: 'private' },
      { id: 'open', owner: 'm-other', visibility: 'workspace' },
    ])
    expect(Object.fromEntries(out)).toEqual({
      'mine-a': { shared_count: 2, shared_with_me: false },
      'mine-b': { shared_count: 0, shared_with_me: false },
      theirs: { shared_count: 0, shared_with_me: true },
      open: { shared_count: 0, shared_with_me: false },
    })
  })

  it('never throws', async () => {
    const out = await listSharingByRecord({} as never, { workspaceId: WS, memberId: 'm-me' }, 'canvas', [{ id: 'a', owner: 'm-me', visibility: 'private' }])
    expect(out.get('a')).toEqual({ shared_count: 0, shared_with_me: false })
  })
})

describe('a canvas row’s chip', () => {
  it('says shared with you, shared with how many, private, or nothing', () => {
    expect(canvasRowChip({ visibility: 'private', sharing: { shared_count: 0, shared_with_me: true } })).toBe('Shared with you')
    expect(canvasRowChip({ visibility: 'private', sharing: { shared_count: 2, shared_with_me: false } })).toBe('Shared · 2')
    expect(canvasRowChip({ visibility: 'private', sharing: { shared_count: 0, shared_with_me: false } })).toBe('Private')
    expect(canvasRowChip({ visibility: 'workspace' })).toBeNull()
  })
})
