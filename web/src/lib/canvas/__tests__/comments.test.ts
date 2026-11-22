/**
 * The canvas comment store over a stand-in client. Who may do what is the
 * database's (migration 682, rehearsed on a real Postgres); here: what is
 * asked of it, what is refused before it is asked, and how its refusals read.
 */
import { describe, expect, it } from 'vitest'
import { addComment, commentsMissing, CommentsUnavailable, deleteComment, listComments, threadsOf, updateComment, type CanvasComment } from '../comments'
import { fakeCanvasDb } from './fake-canvas-db'

const WS = 'ws-1'
const C = '33333333-3333-4333-8333-333333333333'
const T1 = '44444444-4444-4444-8444-444444444441'
const R1 = '44444444-4444-4444-8444-444444444442'
const M1 = 'm-1'
const M2 = 'm-2'

const comment = (id: string, extra: Partial<CanvasComment> & { workspace_id?: string } = {}) => ({
  id,
  canvas_id: C,
  workspace_id: WS,
  parent_id: null,
  item_id: null,
  x: null,
  y: null,
  body: 'Words',
  author_id: M1,
  resolved_at: null,
  resolved_by: null,
  created_at: '2026-11-22T10:00:00Z',
  updated_at: '2026-11-22T10:00:00Z',
  ...extra,
})

const seed = (comments: unknown[] = [], error?: Record<string, { code?: string; message: string }>) =>
  fakeCanvasDb(
    {
      canvas: [{ id: C, workspace_id: WS, title: 'Plan' }],
      member: [
        { id: M1, workspace_id: WS, display_name: 'Ada Example' },
        { id: M2, workspace_id: WS, display_name: 'Ben Example' },
      ],
      canvas_comment: comments as Record<string, unknown>[],
    },
    { error },
  )

describe('threads', () => {
  it('orders threads by when they started, replies under their thread, and drops a reply whose thread is gone', () => {
    const list = [
      comment(R1, { parent_id: T1, created_at: '2026-11-22T10:05:00Z' }),
      comment('later', { created_at: '2026-11-22T11:00:00Z' }),
      comment(T1),
      comment('orphan', { parent_id: 'gone', created_at: '2026-11-22T10:01:00Z' }),
      comment('first-reply', { parent_id: T1, created_at: '2026-11-22T10:02:00Z' }),
    ] as CanvasComment[]
    const threads = threadsOf(list)
    expect(threads.map((t) => t.root.id)).toEqual([T1, 'later'])
    expect(threads[0].replies.map((r) => r.id)).toEqual(['first-reply', R1])
  })
})

describe('reading comments', () => {
  it('returns the canvas\'s comments with their authors\' names', async () => {
    const f = seed([comment(T1), comment(R1, { parent_id: T1, author_id: M2, created_at: '2026-11-22T10:05:00Z' }), comment('x', { canvas_id: 'other' })])
    const list = await listComments(f.client, WS, C)
    expect(list?.map((c) => [c.id, c.author_name])).toEqual([
      [T1, 'Ada Example'],
      [R1, 'Ben Example'],
    ])
  })

  it('is null for a canvas the caller cannot see, or an id that is not one', async () => {
    const f = seed([comment(T1)])
    expect(await listComments(f.client, 'ws-2', C)).toBeNull()
    expect(await listComments(f.client, WS, 'nope')).toBeNull()
  })

  it('says so when the table is not there yet (682 not applied)', async () => {
    const f = seed([], { canvas_comment: { code: '42P01', message: 'relation "public.canvas_comment" does not exist' } })
    await expect(listComments(f.client, WS, C)).rejects.toBeInstanceOf(CommentsUnavailable)
    expect(commentsMissing({ code: 'PGRST205', message: "Could not find the table 'public.canvas_comment' in the schema cache" })).toBe(true)
    expect(commentsMissing({ code: '42501', message: 'new row violates row-level security policy' })).toBe(false)
    expect(commentsMissing(null)).toBe(false)
  })
})

describe('writing a comment', () => {
  it('starts a thread on an item, as the caller, where it was pinned', async () => {
    const f = seed()
    const r = await addComment(f.client, WS, C, M1, { body: '  Tighten this  ', item_id: 'shape-1', x: 120.5, y: -4 })
    expect(r.ok).toBe(true)
    const row = f.rows.canvas_comment[0]
    expect(row).toMatchObject({ canvas_id: C, workspace_id: WS, parent_id: null, item_id: 'shape-1', x: 120.5, y: -4, body: 'Tighten this', author_id: M1 })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(f.calls.filter((c) => c.table === 'canvas_comment').map((c) => c.op)).toEqual(['insert'])
  })

  it('writes a reply on its thread: no item or place of its own', async () => {
    const f = seed([comment(T1, { item_id: 'shape-1' })])
    const r = await addComment(f.client, WS, C, M2, { body: 'Agreed', parent_id: T1, item_id: 'other', x: 1, y: 2 })
    expect(r.ok).toBe(true)
    expect(f.rows.canvas_comment[1]).toMatchObject({ parent_id: T1, item_id: null, x: null, y: null, author_id: M2 })
  })

  it('refuses, before asking the database, what cannot be a comment', async () => {
    const f = seed()
    const bad: Array<[Parameters<typeof addComment>[4], string]> = [
      [{ body: '   ' }, 'invalid'],
      [{ body: 5 }, 'invalid'],
      [{ body: 'x'.repeat(10_001) }, 'invalid'],
      [{ body: 'ok', parent_id: 'not-a-uuid' }, 'invalid'],
      [{ body: 'ok', item_id: 'i'.repeat(65) }, 'invalid'],
      [{ body: 'ok', item_id: 7 }, 'invalid'],
    ]
    for (const [input, reason] of bad) {
      const r = await addComment(f.client, WS, C, M1, input)
      expect(r.ok === false && r.reason, JSON.stringify(input).slice(0, 40)).toBe(reason)
    }
    const hidden = await addComment(f.client, 'ws-2', C, M1, { body: 'ok' })
    expect(hidden.ok === false && hidden.reason).toBe('not_found')
    expect(f.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('drops a place that is not a number', async () => {
    const f = seed()
    await addComment(f.client, WS, C, M1, { body: 'ok', item_id: 'a', x: Number.NaN, y: '4' })
    expect(f.rows.canvas_comment[0]).toMatchObject({ x: null, y: null })
  })

  it('reads the database\'s refusal as forbidden', async () => {
    const f = seed([], { canvas_comment: { code: '42501', message: 'new row violates row-level security policy for table "canvas_comment"' } })
    const r = await addComment(f.client, WS, C, M1, { body: 'ok' })
    expect(r.ok === false && r.reason).toBe('forbidden')
  })
})

describe('changing and deleting a comment', () => {
  it('resolves a thread as the caller, and reopens it', async () => {
    const f = seed([comment(T1)])
    const done = await updateComment(f.client, C, T1, M2, { resolved: true })
    expect(done.ok && done.value.resolved_by).toBe(M2)
    expect(done.ok && typeof done.value.resolved_at).toBe('string')
    const open = await updateComment(f.client, C, T1, M2, { resolved: false })
    expect(open.ok && [open.value.resolved_at, open.value.resolved_by]).toEqual([null, null])
  })

  it('sends only what was asked to change', async () => {
    const f = seed([comment(T1)])
    await updateComment(f.client, C, T1, M1, { body: ' New words ' })
    expect(f.calls.find((c) => c.op === 'update')?.payload).toEqual({ body: 'New words' })
  })

  it('refuses an empty change, an empty body and a resolved that is not yes or no', async () => {
    const f = seed([comment(T1)])
    for (const input of [{}, { body: ' ' }, { resolved: 'yes' }]) {
      const r = await updateComment(f.client, C, T1, M1, input)
      expect(r.ok === false && r.reason).toBe('invalid')
    }
    expect(f.calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('reads the guard\'s refusal as forbidden, and a comment that is not there as not found', async () => {
    const refused = seed([comment(T1)], { canvas_comment: { code: '42501', message: 'Only its author changes a comment.' } })
    const r = await updateComment(refused.client, C, T1, M2, { body: 'Mine now' })
    expect(r.ok === false && r.reason).toBe('forbidden')
    const f = seed([])
    const missing = await updateComment(f.client, C, T1, M1, { resolved: true })
    expect(missing.ok === false && missing.reason).toBe('not_found')
    const badId = await updateComment(f.client, C, 'nope', M1, { resolved: true })
    expect(badId.ok === false && badId.reason).toBe('not_found')
  })

  it('deletes a comment the database lets go, and says forbidden when no row went', async () => {
    const f = seed([comment(T1)])
    expect((await deleteComment(f.client, C, T1)).ok).toBe(true)
    expect(f.rows.canvas_comment).toHaveLength(0)
    const again = await deleteComment(f.client, C, T1)
    expect(again.ok === false && again.reason).toBe('forbidden')
  })
})
