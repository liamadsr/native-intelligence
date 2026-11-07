/**
 * Comments on a document are derived content: they are hidden with it
 * (migration 369, the private-capture rule of tools.capture-visibility.test.ts).
 * These tools run on service-role clients, so the app-layer gate is the real
 * enforcement: someone else's private document reads as not found, the
 * creator's own is theirs, and an unattended run sees no private document.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createCommentTools } from '../comments'

const WS = 'ws-1'
const ME = 'user-me'
const MY_MEMBER = 'm-me'
const ZOE = 'm-zoe'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

function world() {
  const db = makeFakeSupabase()
  db.seed('member', [
    { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: 'admin' },
    { id: ZOE, user_id: 'user-zoe', workspace_id: WS, role: 'member' },
  ])
  db.seed('document', [
    { id: 'doc-shared', workspace_id: WS, title: 'Plan', visibility: 'workspace', created_by: ZOE },
    { id: 'doc-mine', workspace_id: WS, title: 'My prep', visibility: 'private', created_by: MY_MEMBER },
    { id: 'doc-zoe', workspace_id: WS, title: 'Zoe prep', visibility: 'private', created_by: ZOE },
  ])
  db.seed('comment', [
    { id: 'c-1', commentable_type: 'document', commentable_id: 'doc-zoe', body: 'her note', author_id: ZOE, parent_id: null, created_at: 't' },
    { id: 'c-2', commentable_type: 'document', commentable_id: 'doc-mine', body: 'my note', author_id: MY_MEMBER, parent_id: null, created_at: 't' },
    { id: 'c-3', commentable_type: 'document', commentable_id: 'doc-shared', body: 'shared note', author_id: ZOE, parent_id: null, created_at: 't' },
  ])
  return db
}

async function list(documentId: string, omitPrivate = false) {
  const t = createCommentTools(ME, world() as never, WS, omitPrivate)
  const args = (t.list_comments.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
    commentable_type: 'document',
    commentable_id: documentId,
  })
  return (await t.list_comments.execute!(args as never, EXEC)) as { success: boolean; error?: string; comments?: Array<{ body: string }> }
}

describe('comment tools on a private document (369)', () => {
  it("refuses another member's private document with the not-found shape, even for an admin", async () => {
    const res = await list('doc-zoe')
    expect(res.success).toBe(false)
    expect(res.error).toBe('document not found')
    expect(JSON.stringify(res)).not.toContain('her note')
  })

  it('serves the creator their own private document', async () => {
    const res = await list('doc-mine')
    expect(res.success).toBe(true)
    expect(res.comments?.map((c) => c.body)).toEqual(['my note'])
  })

  it('serves a workspace document', async () => {
    expect((await list('doc-shared')).success).toBe(true)
  })

  it('an unattended run sees no private document, not even the run-as user’s own', async () => {
    expect((await list('doc-mine', true)).success).toBe(false)
    expect((await list('doc-shared', true)).success).toBe(true)
  })

  it('gates add_comment the same way', async () => {
    const db = world()
    const t = createCommentTools(ME, db as never, WS)
    const args = (t.add_comment.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      commentable_type: 'document',
      commentable_id: 'doc-zoe',
      body: 'hello',
    })
    const res = (await t.add_comment.execute!(args as never, EXEC)) as { success: boolean }
    expect(res.success).toBe(false)
    expect(db.rows('comment')).toHaveLength(3)
  })
})
