/**
 * Tables as a card (phase 5): `show` opens the Tables page on a table, in a
 * layout (its tab), or on one row (a row's record card), only ever a table
 * the person can read; without grants on a guest's turn.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createShowTools } from '@/lib/ai/tools/show'
import { isPageCardSpec } from '../pages'
import { normalizePageInput } from '../page-validate'
import { WS, ME, ID } from './page-fixtures'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RENTALS = uuid(3001)
const PRIVATE = uuid(3002)
const SHARED = uuid(3003)
const ROW = uuid(3101)
const HIDDEN_ROW = uuid(3102)

function workspace() {
  const db = makeFakeSupabase({
    project: true,
    rpc: {
      // The database's rule: the grant counts only when p_grants is true.
      visible_data_table_ids: (args) => ({ data: (args.p_ids as string[]).filter((id) => id === RENTALS || (id === SHARED && args.p_grants === true)), error: null }),
    },
  })
  db.seed('workspace', [{ id: WS, settings: { edition: 'full', feature_overrides: {} } }])
  db.seed('member', [{ id: ID.myMember, user_id: ME, workspace_id: WS, display_name: 'Avery', role: 'member' }])
  const table = (id: string, name: string, visibility: string) => ({ id, workspace_id: WS, name, visibility, owner_member_id: ID.otherMember, version: 1, position: 0, archived_at: null, created_at: '2026-11-01', updated_at: '2026-11-01' })
  db.seed('data_table', [table(RENTALS, 'Equipment rentals', 'workspace'), table(PRIVATE, 'Payroll notes', 'private'), table(SHARED, 'Shared suppliers', 'private')])
  db.seed('data_row', [
    { id: ROW, workspace_id: WS, table_id: RENTALS, title: 'Tile saw', custom_fields: { status: 'Out' }, position: 1, archived_at: null },
    { id: HIDDEN_ROW, workspace_id: WS, table_id: PRIVATE, title: 'Bonus plan', custom_fields: {}, position: 1, archived_at: null },
  ])
  return db
}

type Exec = (input: unknown) => Promise<Record<string, unknown>>
const show = (db: ReturnType<typeof makeFakeSupabase>, omitGrants = false) => createShowTools(ME, db as never, WS, undefined, [], undefined, omitGrants).show.execute as unknown as Exec

describe('tables as a card', () => {
  it('takes a table or a row as its target, and a layout as its tab ("list" is the grid)', () => {
    expect(normalizePageInput({ kind: 'tables', title: 'Rentals', target: 'Equipment rentals', tab: 'board' })).toEqual({ ok: true, value: { kind: 'tables', title: 'Rentals', target: 'Equipment rentals', tab: 'board' } })
    expect(normalizePageInput({ kind: 'tables', title: 'Rentals', tab: 'list' })).toMatchObject({ ok: true, value: { tab: 'grid' } })
    expect(normalizePageInput({ kind: 'tables', title: 'Rentals', tab: 'timeline' })).toMatchObject({ ok: false, error: expect.stringContaining('grid, board, calendar, gallery') })
    expect(isPageCardSpec({ kind: 'tables', title: 'Tile saw', target: { type: 'data_row', id: ROW, in: RENTALS } })).toBe(true)
    expect(isPageCardSpec({ kind: 'tables', title: 'Tile saw', target: { type: 'data_row', id: ROW, in: 7 } })).toBe(false)
  })

  it('opens on a table by name, as a board, with its first rows', async () => {
    const out = await show(workspace())({ kind: 'tables', title: 'Rentals', target: 'equipment rentals', tab: 'board' })
    expect(out).toMatchObject({ success: true, card: { kind: 'tables', target: { type: 'data_table', id: RENTALS, label: 'Equipment rentals' }, tab: 'board' }, items: [{ id: ROW, title: 'Tile saw' }] })
  })

  it("a row is a record card: the table's page open on that row", async () => {
    const out = await show(workspace())({ kind: 'record', title: 'Tile saw', record: { type: 'data_row', id: ROW } })
    expect(out).toMatchObject({ success: true, card: { kind: 'tables', target: { type: 'data_row', id: ROW, in: RENTALS, label: 'Tile saw' } } })
  })

  it("never opens another member's private table or its rows, and names only readable tables", async () => {
    const db = workspace()
    const byName = await show(db)({ kind: 'tables', title: 'P', target: 'Payroll notes' })
    expect(byName.success).toBe(false)
    expect(JSON.stringify(byName)).not.toContain(PRIVATE)
    expect((await show(db)({ kind: 'tables', title: 'P', target: PRIVATE })).success).toBe(false)
    expect((await show(db)({ kind: 'record', title: 'B', record: { type: 'data_row', id: HIDDEN_ROW } })).success).toBe(false)
    const all = await show(db)({ kind: 'tables', title: 'Tables' })
    expect(all).toMatchObject({ success: true, count: 2 })
    expect(JSON.stringify(all)).not.toContain('Payroll notes')
  })

  it("on a guest's turn a table shared with the person by a grant doesn't show", async () => {
    expect((await show(workspace())({ kind: 'tables', title: 'S', target: 'Shared suppliers' })).success).toBe(true)
    expect((await show(workspace(), true)({ kind: 'tables', title: 'S', target: 'Shared suppliers' })).success).toBe(false)
  })
})
