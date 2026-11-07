/**
 * A comment outlives its author's membership (migration 320): when a member
 * leaves or is removed, their comments stay with no member link and their name
 * copied onto the comment. list_comments and get_comment_replies read that name,
 * so the agent never sees a nameless comment.
 */
import { describe, it, expect } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCommentTools } from '../comments'

const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const ROWS = [
  { id: 'c-member', body: 'still here', author_id: 'm-1', author_name: null, created_at: 't1', edited_at: null, author: { id: 'm-1', display_name: 'Ana' } },
  { id: 'c-former', body: 'I left', author_id: null, author_name: 'Bo', created_at: 't2', edited_at: null, author: null },
]

function makeSupabase() {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'order']) chain[m] = () => chain
    // The document lookup that routes the comment's workspace.
    chain.maybeSingle = async () => ({ data: { workspace_id: 'ws-1' }, error: null })
    chain.single = async () => ({ data: { id: 'c-parent', commentable_type: 'document', commentable_id: 'doc-1' }, error: null })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(table === 'comment' ? { data: ROWS, error: null } : { data: null, error: null }).then(resolve)
    return chain
  }
  return { from } as never
}

describe('comments by someone who has left the workspace', () => {
  it('list_comments names a former member from the comment itself', async () => {
    const tool = createCommentTools('user-1', makeSupabase(), 'ws-1').list_comments
    const res = (await tool.execute!({ commentable_type: 'document', commentable_id: 'doc-1' }, EXEC_OPTS)) as unknown as {
      comments: Array<{ id: string; author_name: string | null }>
    }
    expect(res.comments.map((c) => [c.id, c.author_name])).toEqual([
      ['c-member', 'Ana'],
      ['c-former', 'Bo'],
    ])
  })

  it('get_comment_replies does too', async () => {
    const tool = createCommentTools('user-1', makeSupabase(), 'ws-1').get_comment_replies
    const res = (await tool.execute!({ comment_id: 'c-parent' }, EXEC_OPTS)) as unknown as {
      replies: Array<{ id: string; author_name: string | null }>
    }
    expect(res.replies.map((c) => c.author_name)).toEqual(['Ana', 'Bo'])
  })
})
