import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { readPageChange, resetPageWatch } from '../changes'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const CHANGE = '33333333-3333-4333-8333-333333333333'
const FLOW = '44444444-4444-4444-8444-444444444444'

const row = (over: Record<string, unknown> = {}) => ({
  id: CHANGE,
  flow_id: FLOW,
  workspace_id: WS,
  url: 'https://example.com/pricing',
  added_lines: ['Pro $39 / month', 7, 'Team $99 / month'],
  created_at: '2026-11-15T09:21:00.000Z',
  ...over,
})

describe('readPageChange', () => {
  it('reads one change in its own workspace, keeping only string lines', async () => {
    const db = memoryDb({ flow_page_change: [row()] })
    expect(await readPageChange(db, { workspaceId: WS, changeId: CHANGE })).toEqual({
      id: CHANGE,
      flow_id: FLOW,
      url: 'https://example.com/pricing',
      added_lines: ['Pro $39 / month', 'Team $99 / month'],
      created_at: '2026-11-15T09:21:00.000Z',
    })
  })

  it('never reads another workspace’s change, and refuses ids that are not ids', async () => {
    const db = memoryDb({ flow_page_change: [row()] })
    expect(await readPageChange(db, { workspaceId: OTHER_WS, changeId: CHANGE })).toBeNull()
    expect(await readPageChange(db, { workspaceId: WS, changeId: 'x' })).toBeNull()
    expect(await readPageChange(db, { workspaceId: 'x', changeId: CHANGE })).toBeNull()
  })

  it('a missing change or a failed read is null, never a throw', async () => {
    expect(await readPageChange(memoryDb({ flow_page_change: [] }), { workspaceId: WS, changeId: CHANGE })).toBeNull()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { from: () => { throw new Error('down') } } as never
    expect(await readPageChange(broken, { workspaceId: WS, changeId: CHANGE })).toBeNull()
  })
})

describe('resetPageWatch', () => {
  it('clears the remembered reads and the counts, keeps why it last failed, and touches no other watch', async () => {
    const other = '55555555-5555-4555-8555-555555555555'
    const tables = {
      flow_page_watch: [
        { flow_id: FLOW, workspace_id: WS, url: 'https://example.com/', fingerprints: [['a'], ['b']], line_count: 12, failures: 5, judge_failures: 2, last_error: 'The page took too long to answer.' },
        { flow_id: other, workspace_id: WS, url: 'https://example.org/', fingerprints: [['c']], line_count: 3, failures: 1, judge_failures: 0, last_error: null },
      ],
    }
    await resetPageWatch(memoryDb(tables), FLOW)
    expect(tables.flow_page_watch[0]).toMatchObject({ fingerprints: [], line_count: null, failures: 0, judge_failures: 0, last_error: 'The page took too long to answer.' })
    expect(tables.flow_page_watch[1]).toMatchObject({ fingerprints: [['c']], failures: 1 })
  })

  it('never throws: not an id, no row, or a failed write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(resetPageWatch(memoryDb({}), 'x')).resolves.toBeUndefined()
    await expect(resetPageWatch(memoryDb({ flow_page_watch: [] }), FLOW)).resolves.toBeUndefined()
    const broken = { from: () => { throw new Error('down') } } as never
    await expect(resetPageWatch(broken, FLOW)).resolves.toBeUndefined()
  })
})
