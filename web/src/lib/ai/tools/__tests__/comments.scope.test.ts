/**
 * Regression: add_comment must verify the target entity belongs to the active
 * workspace BEFORE inserting a comment against it (mirrors list_comments /
 * get_comment_replies). These tools run under service-role clients that bypass
 * RLS, so this app-layer check is the only real gate.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCommentTools } from '../comments'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * Supabase double.
 *   from(<action|capture|document table>) → entity lookup: single() (and the
 *     maybeSingle() that resolveEntityWorkspace / captureVisibleToRequester use)
 *     returns a row only when (id, workspace_id) is present in `owned[table]`.
 *     The row carries its workspace_id, because routing reads that column.
 *   from('member') → resolveMember: single() returns m-1.
 *   from('comment') → insert().select().single() returns a stub comment.
 */
function makeSupabase(owned: Record<string, Set<string>>) {
  const commentInsert = vi.fn()
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    const result = async () => {
      if (table === 'member') return { data: { id: 'm-1' }, error: null }
      if (table === 'comment') {
        return { data: { id: 'cmt-1', body: 'x', created_at: 't' }, error: null }
      }
      // entity lookup (actions / captures / document)
      const id = filters['id'] as string
      const ws = filters['workspace_id'] as string
      const has = ws === WORKSPACE_ID && owned[table]?.has(id)
      return { data: has ? { id, workspace_id: ws } : null, error: null }
    }
    const chain: Record<string, unknown> = {
      single: result,
      maybeSingle: result,
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'then' || p === 'catch' || p === 'finally') return undefined
        if (p === 'eq') return (col: string, val: unknown) => ((filters[col] = val), proxy)
        if (p === 'insert')
          return (row: unknown) => {
            if (table === 'comment') commentInsert(row)
            return proxy
          }
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from } as never, commentInsert }
}

describe('add_comment — target workspace scoping', () => {
  it('rejects a commentable_id not in the workspace and does not insert', async () => {
    const { supabase, commentInsert } = makeSupabase({ actions: new Set() })
    const tool = createCommentTools(USER_ID, supabase, WORKSPACE_ID).add_comment
    const res = (await tool.execute!(
      { commentable_type: 'action', commentable_id: 'foreign-action', body: 'hi' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(commentInsert).not.toHaveBeenCalled()
  })

  it('inserts when the target belongs to the workspace', async () => {
    const { supabase, commentInsert } = makeSupabase({ captures: new Set(['cap-1']) })
    const tool = createCommentTools(USER_ID, supabase, WORKSPACE_ID).add_comment
    const res = (await tool.execute!(
      { commentable_type: 'capture', commentable_id: 'cap-1', body: 'hi' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean }
    expect(res.success).toBe(true)
    expect(commentInsert).toHaveBeenCalledTimes(1)
  })
})
