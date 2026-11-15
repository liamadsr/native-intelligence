/**
 * Who may read an uploaded file (../visibility.ts), as the attachments table's
 * read rule says: its uploader, anyone for a file on no capture, and on a
 * capture only someone who may see that capture (a workspace one, their own,
 * or one a grant opens to them; never an eval capture), and on a table's row
 * (migration 663: a form's upload) only someone who can read the row's
 * table, whoever uploaded it. Fails closed.
 * Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { filterRowAttachments, filterVisibleAttachments, visibleAttachmentIds } from '../visibility'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '11111111-1111-4111-8111-222222222222'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const ANA_MEMBER = '33333333-3333-4333-8333-aaaaaaaaaaaa'

const SHARED_CALL = 'c0000000-0000-4000-8000-000000000001'
const BEN_PRIVATE = 'c0000000-0000-4000-8000-000000000002'
const BEN_GRANTED = 'c0000000-0000-4000-8000-000000000003'
const EVAL_CALL = 'c0000000-0000-4000-8000-000000000004'

const f = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`
const ON_TASK = f(1)
const ON_SHARED = f(2)
const ON_BEN_PRIVATE = f(3)
const ANA_ON_BEN_PRIVATE = f(4)
const ON_GRANTED = f(5)
const ON_EVAL = f(6)
const FOREIGN = f(7)

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [{ id: ANA_MEMBER, user_id: ANA, workspace_id: WS, role: 'member' }],
    captures: [
      { id: SHARED_CALL, workspace_id: WS, visibility: 'workspace', user_id: BEN, is_eval: false },
      { id: BEN_PRIVATE, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false },
      { id: BEN_GRANTED, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false },
      { id: EVAL_CALL, workspace_id: WS, visibility: 'workspace', user_id: BEN, is_eval: true },
    ],
    entity_access: [
      { workspace_id: WS, entity_type: 'capture', entity_id: BEN_GRANTED, grantee_kind: 'member', grantee_member_id: ANA_MEMBER, level: 'view' },
    ],
    attachments: [
      { id: ON_TASK, workspace_id: WS, user_id: BEN, note_id: null, action_id: 'a1', file_name: 'brief.pdf' },
      { id: ON_SHARED, workspace_id: WS, user_id: BEN, note_id: SHARED_CALL, file_name: 'slides.pdf' },
      { id: ON_BEN_PRIVATE, workspace_id: WS, user_id: BEN, note_id: BEN_PRIVATE, file_name: 'salary.xlsx' },
      { id: ANA_ON_BEN_PRIVATE, workspace_id: WS, user_id: ANA, note_id: BEN_PRIVATE, file_name: 'mine.png' },
      { id: ON_GRANTED, workspace_id: WS, user_id: BEN, note_id: BEN_GRANTED, file_name: 'shared-with-ana.pdf' },
      { id: ON_EVAL, workspace_id: WS, user_id: BEN, note_id: EVAL_CALL, file_name: 'eval.pdf' },
      { id: FOREIGN, workspace_id: OTHER_WS, user_id: ANA, note_id: null, file_name: 'elsewhere.pdf' },
    ],
  }
})

const ALL = [ON_TASK, ON_SHARED, ON_BEN_PRIVATE, ANA_ON_BEN_PRIVATE, ON_GRANTED, ON_EVAL, FOREIGN]

describe('visibleAttachmentIds', () => {
  it('a member reads files on no capture, on a capture they may see, their own, and what a grant opens', async () => {
    const ids = await visibleAttachmentIds(memoryDb(tables), { workspaceId: WS, userId: ANA }, ALL)
    expect([...ids].sort()).toEqual([ON_TASK, ON_SHARED, ANA_ON_BEN_PRIVATE, ON_GRANTED].sort())
  })

  it('never a teammate’s file on their private capture, an eval capture’s, or another workspace’s', async () => {
    const ids = await visibleAttachmentIds(memoryDb(tables), { workspaceId: WS, userId: ANA }, ALL)
    for (const hidden of [ON_BEN_PRIVATE, ON_EVAL, FOREIGN]) expect(ids.has(hidden)).toBe(false)
  })

  it('with no person, only what every member reads', async () => {
    const ids = await visibleAttachmentIds(memoryDb(tables), { workspaceId: WS, userId: null }, ALL)
    expect([...ids].sort()).toEqual([ON_TASK, ON_SHARED].sort())
  })

  it('fails closed: a failed read shows nothing', async () => {
    const broken = {
      from: () => {
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'or', 'neq']) q[m] = () => q
        q.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: 'down' } })
        return q
      },
    } as unknown as SupabaseClient
    expect((await visibleAttachmentIds(broken, { workspaceId: WS, userId: ANA }, ALL)).size).toBe(0)
  })

  it('a capture read that fails drops every file on a capture, keeps the rest', async () => {
    const db = memoryDb(tables)
    const failingCaptures = {
      from: (table: string) => {
        if (table !== 'captures') return db.from(table)
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'or', 'neq']) q[m] = () => q
        q.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: 'down' } })
        return q
      },
    } as unknown as SupabaseClient
    const rows = tables.attachments.filter((r) => r.workspace_id === WS) as Array<{ id: string; user_id: string; note_id: string | null }>
    const kept = await filterVisibleAttachments(failingCaptures, { workspaceId: WS, userId: ANA }, rows)
    expect(kept.map((r) => r.id).sort()).toEqual([ON_TASK, ANA_ON_BEN_PRIVATE].sort())
  })
})

describe('a file on a table’s row', () => {
  const OPEN_TABLE = 'd0000000-0000-4000-8000-000000000001'
  const PRIVATE_TABLE = 'd0000000-0000-4000-8000-000000000002'
  const OPEN_ROW = 'e0000000-0000-4000-8000-000000000001'
  const PRIVATE_ROW = 'e0000000-0000-4000-8000-000000000002'
  const ON_OPEN_ROW = f(8)
  const ON_PRIVATE_ROW = f(9)

  /** The memory database, with the tables rule as the database answers it: Ana reads OPEN_TABLE only. */
  function withRows(over: { rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> } = {}) {
    tables.data_row = [
      { id: OPEN_ROW, workspace_id: WS, table_id: OPEN_TABLE },
      { id: PRIVATE_ROW, workspace_id: WS, table_id: PRIVATE_TABLE },
    ]
    tables.attachments.push(
      { id: ON_OPEN_ROW, workspace_id: WS, user_id: null, note_id: null, data_row_id: OPEN_ROW, from_form: true, file_name: 'rug.png' },
      { id: ON_PRIVATE_ROW, workspace_id: WS, user_id: ANA, note_id: null, data_row_id: PRIVATE_ROW, file_name: 'payroll.pdf' },
    )
    const db = memoryDb(tables)
    const calls: Array<Record<string, unknown>> = []
    const rpc =
      over.rpc ??
      (async (fn: string, args: Record<string, unknown>) => {
        expect(fn).toBe('visible_data_table_ids')
        calls.push(args)
        return { data: args.p_user_id === ANA ? (args.p_ids as string[]).filter((id) => id === OPEN_TABLE || (args.p_grants === true && id === 'never')) : [], error: null }
      })
    return { db: { from: db.from.bind(db), rpc } as unknown as SupabaseClient, calls }
  }

  it('is read only when the row’s table is, even by the one who uploaded it', async () => {
    const { db } = withRows()
    const ids = await visibleAttachmentIds(db, { workspaceId: WS, userId: ANA }, [ON_TASK, ON_OPEN_ROW, ON_PRIVATE_ROW])
    expect([...ids].sort()).toEqual([ON_TASK, ON_OPEN_ROW].sort())
  })

  it('a caller that did not select data_row_id is fenced all the same (the row is read here)', async () => {
    const { db } = withRows()
    const rows = (tables.attachments as Array<{ id: string; user_id: string | null; note_id: string | null }>).filter((r) => [ON_TASK, ON_OPEN_ROW, ON_PRIVATE_ROW].includes(r.id)).map(({ id, user_id, note_id }) => ({ id, user_id, note_id }))
    const kept = await filterVisibleAttachments(db, { workspaceId: WS, userId: ANA }, rows)
    expect(kept.map((r) => r.id).sort()).toEqual([ON_TASK, ON_OPEN_ROW].sort())
  })

  it('with no person, no row’s file is anyone’s', async () => {
    const { db, calls } = withRows()
    const ids = await visibleAttachmentIds(db, { workspaceId: WS, userId: null }, [ON_TASK, ON_OPEN_ROW])
    expect([...ids]).toEqual([ON_TASK])
    expect(calls).toHaveLength(0)
  })

  it('fails closed: a table rule that can’t be read hides every row’s file, and nothing else', async () => {
    const { db } = withRows({ rpc: async () => ({ data: null, error: { message: 'down' } }) })
    const ids = await visibleAttachmentIds(db, { workspaceId: WS, userId: ANA }, [ON_TASK, ON_OPEN_ROW])
    expect([...ids]).toEqual([ON_TASK])
  })

  it('the row rule alone, for a reader that fences captures its own way, without grants when told', async () => {
    const { db, calls } = withRows()
    const rows = [
      { id: ON_TASK, note_id: null, data_row_id: null },
      { id: ON_OPEN_ROW, note_id: null, data_row_id: OPEN_ROW },
      { id: ON_PRIVATE_ROW, note_id: null, data_row_id: PRIVATE_ROW },
    ]
    expect((await filterRowAttachments(db, { workspaceId: WS, userId: ANA }, rows, { grants: false })).map((r) => r.id)).toEqual([ON_TASK, ON_OPEN_ROW])
    expect(calls[0]).toMatchObject({ p_user_id: ANA, p_grants: false })
  })
})
