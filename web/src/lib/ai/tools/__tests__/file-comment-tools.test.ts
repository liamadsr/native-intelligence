/**
 * comment_on_file (migration 706): the file's own read rule asked for the
 * person first; written as them, marked as their assistant's; never on a
 * guest's or a linked agent's turn; never a mail attachment's (no target
 * names one). Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  visible: true,
  added: [] as unknown[],
  after: [] as unknown[],
}))
vi.mock('@/lib/attachments/visibility', () => ({
  filterVisibleAttachments: async (_s: unknown, _scope: unknown, rows: unknown[]) => (h.visible ? rows : []),
}))
vi.mock('@/lib/record-comments/mentions', () => ({
  fenceRecordCommentMentions: async () => ({ memberIds: ['mem-bo'], records: [] }),
  afterRecordComment: async (_s: unknown, saved: unknown) => void h.after.push(saved),
}))
vi.mock('@/lib/drive/file-comments', async (orig) => ({
  ...(await orig<typeof import('@/lib/drive/file-comments')>()),
  addFileComment: async (_s: unknown, ws: string, me: string, target: unknown, input: Record<string, unknown>, opts: unknown) => {
    h.added.push({ ws, me, target, input, opts })
    return { ok: true, value: { id: 'cm-1', parent_id: null, page: input.page ?? null } }
  },
  listFileComments: async () => ({ ok: true, value: [{ id: 'th-1', parent_id: null, created_at: '2026-11-20T00:00:00Z' }] }),
}))

import { createFileCommentTools } from '../file-comments'

const ATT = '11111111-1111-4111-8111-111111111111'
const MSG = '22222222-2222-4222-8222-222222222222'
const PATH = '33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444/a.pdf'

function supabase(opts: { chatVisible?: boolean } = {}) {
  return {
    from: (table: string) => {
      const q: Record<string, (...a: unknown[]) => unknown> = {}
      for (const m of ['select', 'eq']) q[m] = () => q
      q.maybeSingle = async () => {
        if (table === 'member') return { data: { id: 'mem-me', role: 'member' }, error: null }
        if (table === 'attachments') return { data: { id: ATT, workspace_id: 'ws', user_id: 'u-bo', note_id: null, data_row_id: null, file_name: 'plan.pdf' }, error: null }
        if (table === 'team_chat_message') return { data: { id: MSG, workspace_id: 'ws', deleted_at: null, attachments: [{ path: PATH, name: 'brief.pdf' }] }, error: null }
        return { data: null, error: null }
      }
      return q
    },
    rpc: async () => ({ data: opts.chatVisible ?? true, error: null }),
  } as unknown as SupabaseClient
}

type Exec = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const run = (tools: ReturnType<typeof createFileCommentTools>, input: Record<string, unknown>) => (tools.comment_on_file as unknown as { execute: Exec }).execute(input)

beforeEach(() => {
  h.visible = true
  h.added.length = 0
  h.after.length = 0
})

describe('comment_on_file', () => {
  it('pins a comment on a page of an upload the person can read, as their assistant', async () => {
    const out = await run(createFileCommentTools('u-me', supabase(), 'ws'), { attachment_id: ATT, body: 'Check this total', page: 2, x: 0.5, y: 0.25, mention_member_ids: ['mem-bo'] })
    expect(out.success).toBe(true)
    expect(h.added).toEqual([{ ws: 'ws', me: 'mem-me', target: { kind: 'attachment', id: ATT }, input: { body: 'Check this total', parent_id: null, page: 2, x: 0.5, y: 0.25, mentions: ['mem-bo'] }, opts: { viaAgent: true } }])
    expect(h.after[0]).toMatchObject({ kind: 'attachment', recordId: ATT, viaAgent: true })
  })

  it('refuses a file the person cannot read', async () => {
    h.visible = false
    const out = await run(createFileCommentTools('u-me', supabase(), 'ws'), { attachment_id: ATT, body: 'x' })
    expect(out.success).toBe(false)
    expect(h.added).toEqual([])
  })

  it('comments on a chat file only through its message’s rule', async () => {
    const ok = await run(createFileCommentTools('u-me', supabase(), 'ws'), { message_id: MSG, file_path: PATH, body: 'Nice' })
    expect(ok.success).toBe(true)
    expect(h.after[0]).toMatchObject({ kind: 'team_chat_file', recordId: MSG, recordTitle: 'brief.pdf' })
    const no = await run(createFileCommentTools('u-me', supabase({ chatVisible: false }), 'ws'), { message_id: MSG, file_path: PATH, body: 'Nice' })
    expect(no.success).toBe(false)
  })

  it('writes nothing on a guest’s or linked agent’s turn, or without a file named', async () => {
    expect((await run(createFileCommentTools('u-me', supabase(), 'ws', true), { attachment_id: ATT, body: 'x' })).success).toBe(false)
    expect((await run(createFileCommentTools('u-me', supabase(), 'ws'), { body: 'x' })).success).toBe(false)
    expect(h.added).toEqual([])
  })

  it('replies only on a thread of the file, and needs a whole place', async () => {
    const tools = createFileCommentTools('u-me', supabase(), 'ws')
    expect((await run(tools, { attachment_id: ATT, body: 'x', reply_to: 'nope' })).success).toBe(false)
    expect((await run(tools, { attachment_id: ATT, body: 'x', page: 1 })).success).toBe(false)
    expect((await run(tools, { attachment_id: ATT, body: 'Agreed', reply_to: 'th-1' })).success).toBe(true)
  })
})
