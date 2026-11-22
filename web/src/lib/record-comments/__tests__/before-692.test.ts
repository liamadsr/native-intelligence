/**
 * A database that has not had migration 692 yet has no via_agent column.
 * Comments must still be read and written there (682 and 675 are live before
 * 692 is): the read is asked again without the column, and a person's comment
 * never sends it.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { addComment, listComments } from '@/lib/canvas/comments'
import { createThread, listThreads } from '@/lib/spreadsheets/comments'

const WS = 'ws-1'
const CV = '33333333-3333-4333-8333-333333333333'
const SS = '33333333-3333-4333-8333-333333333334'
type Row = Record<string, unknown>

/** A client whose two comment tables refuse any mention of via_agent, as PostgREST does for a column that is not there. */
function without692(tables: Record<string, Row[]>) {
  const asked: string[] = []
  const base = memoryDb(tables)
  const from = base.from.bind(base)
  const missing = (table: string) => ({ data: null, error: { code: '42703', message: `column ${table}.via_agent does not exist` } })
  const db = Object.assign(base, {
    from: (table: string) => {
      const q = from(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'canvas_comment' && table !== 'spreadsheet_comment') return q
      const select = q.select.bind(q)
      const insert = q.insert.bind(q)
      const refused = () => {
        const chain: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve(missing(table)).then(r) }
        for (const m of ['eq', 'order', 'range', 'maybeSingle', 'single', 'select', 'in']) chain[m] = () => chain
        return chain
      }
      q.select = (...a: unknown[]) => {
        asked.push(String(a[0]))
        return String(a[0]).includes('via_agent') ? refused() : select(...a)
      }
      q.insert = (...a: unknown[]) => ('via_agent' in (a[0] as Row) ? refused() : insert(...a))
      return q
    },
  }) as unknown as SupabaseClient
  return { db, asked }
}

const tables = (): Record<string, Row[]> => ({
  canvas: [{ id: CV, workspace_id: WS, title: 'Plan' }],
  member: [{ id: 'm-1', workspace_id: WS, display_name: 'Ada Example' }],
  canvas_comment: [{ id: '44444444-4444-4444-8444-444444444441', canvas_id: CV, workspace_id: WS, parent_id: null, item_id: null, x: null, y: null, body: 'Old one', mentions: [], author_id: 'm-1', resolved_at: null, resolved_by: null, created_at: '2026-11-22T10:00:00Z', updated_at: '2026-11-22T10:00:00Z' }],
  spreadsheet_comment: [{ id: 's-1', spreadsheet_id: SS, workspace_id: WS, parent_id: null, sheet_id: 1, anchor: 'A1', body: 'Cell note', mentions: [], author_id: 'm-1', resolved_at: null, resolved_by: null, created_at: '2026-11-22T10:00:00Z', updated_at: '2026-11-22T10:00:00Z' }],
})

describe('before migration 692 is applied', () => {
  it('canvas comments are read (asked again without the mark) and nobody is the assistant', async () => {
    const { db, asked } = without692(tables())
    const list = await listComments(db, WS, CV)
    expect(list?.map((c) => [c.body, c.via_agent])).toEqual([['Old one', false]])
    expect(asked.filter((s) => s.includes('via_agent'))).toHaveLength(1)
    expect(asked.some((s) => s.includes('body') && !s.includes('via_agent'))).toBe(true)
  })

  it('a person writes a canvas comment; the assistant is told the server is missing an update', async () => {
    const t = tables()
    const { db } = without692(t)
    const byHand = await addComment(db, WS, CV, 'm-1', { body: 'Still works' })
    expect(byHand.ok && byHand.value.body).toBe('Still works')
    const byAgent = await addComment(db, WS, CV, 'm-1', { body: 'From the assistant', viaAgent: true })
    expect(byAgent.ok === false && byAgent.error).toContain('missing an update')
    expect(t.canvas_comment.map((r) => r.body)).toEqual(['Old one', 'Still works'])
  })

  it('spreadsheet threads are read and written the same way', async () => {
    const t = tables()
    const { db } = without692(t)
    const threads = await listThreads(db, SS)
    expect(threads.map((x) => [x.root.body, x.root.via_agent])).toEqual([['Cell note', false]])
    const byHand = await createThread(db, { workspaceId: WS, spreadsheetId: SS, memberId: 'm-1', sheetId: 1, anchor: 'B2', body: 'By hand' })
    expect(byHand.ok && byHand.value.via_agent).toBe(false)
    const byAgent = await createThread(db, { workspaceId: WS, spreadsheetId: SS, memberId: 'm-1', sheetId: 1, anchor: 'B3', body: 'By the assistant', viaAgent: true })
    expect(byAgent.ok === false && byAgent.message).toContain('missing an update')
    expect(t.spreadsheet_comment).toHaveLength(2)
  })
})
