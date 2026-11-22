/**
 * The assistant commenting on a canvas for the person: as the person, marked
 * as the assistant's, only on a canvas they can open, and telling who it
 * names. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const told = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/record-comments/notify', () => ({ sendRecordCommentNotifications: vi.fn(async (n: Record<string, unknown>) => (told.list.push(n), 0)) }))

const { createCanvasTools } = await import('../canvas')
const { getToolDefinition, getMutatingToolNames, REPORT_MODE_WRITE_ALLOWLIST } = await import('../../tool-registry')

const WS = '11111111-1111-4111-8111-111111111111'
const CV = '33333333-3333-4333-8333-333333333333'
const HIDDEN = '55555555-5555-4555-8555-555555555555'
const THREAD = '66666666-6666-4666-8666-666666666666'
const REPLY = '66666666-6666-4666-8666-666666666667'
const ME = 'u-ada'
const [ADA, BEN] = ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772']

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let markColumn = true

function db(): SupabaseClient {
  const base = memoryDb(tables)
  const from = base.from.bind(base)
  return Object.assign(base, {
    // A database without migration 692 has no via_agent column.
    from: (table: string) => {
      const q = from(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'canvas_comment' || markColumn) return q
      const insert = q.insert.bind(q)
      q.insert = (...a: unknown[]) => { const row = a[0] as Row; return 'via_agent' in row ? { then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'via_agent' column of 'canvas_comment' in the schema cache" } }).then(r) } : insert(row) }
      return q
    },
    rpc: async (fn: string, args: Record<string, string>) => {
      if (fn === 'canvas_visible_to') return { data: args.p_canvas_id === CV && args.p_user_id === ME, error: null }
      if (fn === 'canvas_editable_by') return { data: false, error: null }
      return { data: null, error: null }
    },
  }) as unknown as SupabaseClient
}

const call = async (name: string, input: Row) => (await ((createCanvasTools(ME, db(), WS) as Record<string, unknown>)[name] as { execute: (i: unknown, o: unknown) => Promise<Row> }).execute(input, {})) as Row

beforeEach(() => {
  told.list = []
  markColumn = true
  tables = {
    canvas: [
      { id: CV, workspace_id: WS, title: 'Launch plan', visibility: 'workspace', archived_at: null },
      { id: HIDDEN, workspace_id: WS, title: 'Private notes', visibility: 'private', archived_at: null },
    ],
    canvas_item: [{ canvas_id: CV, id: 'box-1', workspace_id: WS, parent_id: null, sort_key: 'a1', kind: 'rectangle', data: { x: 0, y: 0, w: 10, h: 10, rotation: 0, style: {} } }],
    canvas_comment: [
      { id: THREAD, canvas_id: CV, workspace_id: WS, parent_id: null, item_id: null, body: 'Dates?', mentions: [], author_id: BEN, resolved_at: null, resolved_by: null, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' },
      { id: REPLY, canvas_id: CV, workspace_id: WS, parent_id: THREAD, item_id: null, body: 'Soon', mentions: [], author_id: ADA, resolved_at: null, resolved_by: null, created_at: '2026-11-20T10:05:00Z', updated_at: '2026-11-20T10:05:00Z' },
    ],
    member: [
      { id: ADA, workspace_id: WS, user_id: ME, display_name: 'Ada Example' },
      { id: BEN, workspace_id: WS, user_id: 'u-ben', display_name: 'Ben Example' },
    ],
  }
})

describe('how the comment tools are classed', () => {
  it('are internal writes to the board, like add_comment: no card, not reviewed, and off in report mode', () => {
    for (const name of ['comment_on_canvas', 'resolve_canvas_comment', 'comment_on_spreadsheet', 'resolve_spreadsheet_comment']) {
      const def = getToolDefinition(name)!
      expect([def.sideEffect, def.writeTarget], name).toEqual(['internal-write', 'board'])
      expect(getMutatingToolNames().has(name), name).toBe(true)
      expect((REPORT_MODE_WRITE_ALLOWLIST as readonly string[]).includes(name), name).toBe(false)
    }
    expect([getToolDefinition('add_comment')!.sideEffect, getToolDefinition('add_comment')!.writeTarget]).toEqual(['internal-write', 'board'])
  })
})

describe('comment_on_canvas', () => {
  it('starts a thread on an item as the person, marked as the assistant\'s, even on a canvas they can only view', async () => {
    const r = await call('comment_on_canvas', { canvas_id: CV, body: '  Is this the final layout?  ', item_id: 'box-1' })
    expect(r.success).toBe(true)
    const row = tables.canvas_comment.at(-1)!
    expect(row).toMatchObject({ canvas_id: CV, workspace_id: WS, author_id: ADA, via_agent: true, item_id: 'box-1', parent_id: null, body: 'Is this the final layout?' })
    expect(r.comment).toMatchObject({ id: row.id, thread: row.id, item: 'box-1' })
    expect(String(r.message)).toContain('written by their assistant')
  })

  it('replies on a thread, and tells who it names and the thread, as the assistant\'s', async () => {
    const r = await call('comment_on_canvas', { canvas_id: CV, body: 'Friday, @Ben Example', reply_to: THREAD, mention_member_ids: [BEN, 'not-an-id', '99999999-9999-4999-8999-999999999999'] })
    expect(r).toMatchObject({ success: true, mentioned: 1 })
    expect(tables.canvas_comment.at(-1)).toMatchObject({ parent_id: THREAD, item_id: null, mentions: [BEN], via_agent: true })
    expect(told.list[0]).toMatchObject({ kind: 'canvas', recordId: CV, authorMemberId: ADA, parentId: THREAD, mentionedMemberIds: [BEN], viaAgent: true })
  })

  it('drops a mention whose @ is not in the words', async () => {
    const r = await call('comment_on_canvas', { canvas_id: CV, body: 'No names here', mention_member_ids: [BEN] })
    expect(r.mentioned).toBe(0)
    expect(tables.canvas_comment.at(-1)!.mentions).toEqual([])
  })

  it('refuses a canvas the person cannot open, an item that is not there, and a reply to a reply', async () => {
    const before = tables.canvas_comment.length
    expect((await call('comment_on_canvas', { canvas_id: HIDDEN, body: 'Hi' })).success).toBe(false)
    expect((await call('comment_on_canvas', { canvas_id: 'nope', body: 'Hi' })).success).toBe(false)
    expect(String((await call('comment_on_canvas', { canvas_id: CV, body: 'Hi', item_id: 'ghost' })).error)).toContain('No item')
    expect((await call('comment_on_canvas', { canvas_id: CV, body: 'Hi', reply_to: REPLY })).success).toBe(false)
    expect(tables.canvas_comment).toHaveLength(before)
    expect(told.list).toEqual([])
  })

  it('says so, and writes nothing, on a server that cannot mark a comment yet', async () => {
    markColumn = false
    const before = tables.canvas_comment.length
    const r = await call('comment_on_canvas', { canvas_id: CV, body: 'Hi' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('missing an update')
    expect(tables.canvas_comment).toHaveLength(before)
  })
})

describe('resolve_canvas_comment', () => {
  it('resolves a thread as the person, and reopens it', async () => {
    expect(await call('resolve_canvas_comment', { canvas_id: CV, thread_id: THREAD })).toMatchObject({ success: true, resolved: true })
    expect(tables.canvas_comment[0]).toMatchObject({ resolved_by: ADA })
    expect(tables.canvas_comment[0].body).toBe('Dates?')
    expect(await call('resolve_canvas_comment', { canvas_id: CV, thread_id: THREAD, resolved: false })).toMatchObject({ success: true, resolved: false })
    expect(tables.canvas_comment[0]).toMatchObject({ resolved_at: null, resolved_by: null })
  })

  it('refuses a reply\'s id, an unknown thread and a canvas the person cannot open', async () => {
    expect((await call('resolve_canvas_comment', { canvas_id: CV, thread_id: REPLY })).success).toBe(false)
    expect((await call('resolve_canvas_comment', { canvas_id: CV, thread_id: '66666666-6666-4666-8666-66666666666f' })).success).toBe(false)
    expect((await call('resolve_canvas_comment', { canvas_id: HIDDEN, thread_id: THREAD })).success).toBe(false)
    expect(tables.canvas_comment[0].resolved_at).toBeNull()
  })

  it('has no way to change or delete anyone\'s words', () => {
    const tools = Object.keys(createCanvasTools(ME, db(), WS))
    expect(tools.sort()).toEqual(['comment_on_canvas', 'create_canvas', 'edit_canvas', 'read_canvas', 'resolve_canvas_comment'])
  })
})

describe('read_canvas', () => {
  it('lists open threads with their ids, and says which the assistant wrote', async () => {
    await call('comment_on_canvas', { canvas_id: CV, body: 'A note from the assistant' })
    const r = await call('read_canvas', { canvas_id: CV })
    const comments = r.comments as Array<Record<string, unknown>>
    expect(comments.map((c) => [c.text, c.by_assistant ?? false])).toEqual([['Dates?', false], ['A note from the assistant', true]])
    expect(comments[0].id).toBe(THREAD)
  })
})
