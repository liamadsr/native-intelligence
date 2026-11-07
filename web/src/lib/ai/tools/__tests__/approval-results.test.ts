/**
 * get_tool_approval_result (GEN-1172): how a held call ended, by its
 * approval_id, the caller's own rows in this workspace only.
 */
import { describe, expect, it } from 'vitest'
import { filterDb } from '@/test/filter-db'
import { createApprovalResultTools } from '../approval-results'

const ID = '0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d'
const row = {
  id: ID,
  user_id: 'user-1',
  workspace_id: 'ws-1',
  tool: 'mcp__supabase__execute_sql',
  status: 'approved',
  input: { query: 'select 1' },
  result: { success: true, isError: false, content: [{ type: 'text', text: '[{"?column?":1}]' }] },
  decided_at: '2026-10-27T11:00:00Z',
  executed_at: '2026-10-27T11:00:01Z',
}
type Exec = (input: unknown, opts?: unknown) => Promise<Record<string, unknown>>
const run = (db: unknown, userId = 'user-1', workspaceId = 'ws-1') =>
  (createApprovalResultTools(userId, db as never, workspaceId).get_tool_approval_result as unknown as { execute: Exec }).execute({ approval_id: ID }, {})

describe('get_tool_approval_result', () => {
  it('reads the caller’s own held call: its outcome and result, fenced', async () => {
    const out = await run(filterDb({ tool_approval: [row] }))
    expect(out).toMatchObject({ success: true, approval_id: ID, outcome: 'ran', tool: 'mcp__supabase__execute_sql' })
    expect(String(out.result)).toMatch(/^\[UNTRUSTED TOOL CONTENT[\s\S]*\[\{"\?column\?":1\}\]\n\[END UNTRUSTED CONTENT\]$/)
  })

  it('never another person’s, or another workspace’s', async () => {
    expect(await run(filterDb({ tool_approval: [row] }), 'user-2')).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await run(filterDb({ tool_approval: [row] }), 'user-1', 'ws-2')).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('a call still waiting says so, with no result', async () => {
    const out = await run(filterDb({ tool_approval: [{ ...row, status: 'pending', executed_at: null, result: null, expires_at: '2999-01-01T00:00:00Z' }] }))
    expect(out).toMatchObject({ success: true, outcome: 'waiting' })
    expect(out).not.toHaveProperty('result')
  })

  it('a failed read says so', async () => {
    expect(await run(filterDb({ tool_approval: [row] }, [], ['tool_approval']))).toMatchObject({ success: false })
  })

  it('takes only an approval id', () => {
    const schema = createApprovalResultTools('u', {} as never, 'w').get_tool_approval_result.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ approval_id: ID }).success).toBe(true)
    expect(schema.safeParse({ approval_id: 'drop table' }).success).toBe(false)
  })
})
