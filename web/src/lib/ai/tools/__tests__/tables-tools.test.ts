/**
 * The agent's table tools (Tables, phase 5): registered where they belong,
 * fenced to what the person can read (without grants on a guest's turn),
 * and every write one batch with the person named, source 'agent', the
 * reason, and (a guest's turn) no grants for the database either (530).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ queryRows: vi.fn() }))
vi.mock('@/lib/tables/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/tables/store')>()
  return { ...real, queryRows: hoisted.queryRows }
})

import { createTableTools, dayWordDate, TABLE_TOOL_NAMES } from '../tables'
import { getToolDefinition, getMutatingToolNames, isReadShapedToolName } from '../../tool-registry'
import { withToolGuide, MAX_ADVERTISED_DESCRIPTION } from '../../tool-guides'
import { isToolExcludedForSurface } from '@/lib/chat/chat-ceiling'
import { fakeTablesDb, type RpcAnswer } from '@/lib/tables/__tests__/fake-tables-db'

const WS = 'ws-1'
const ME = 'u-1'
const RENTALS = '33333333-3333-4333-8333-333333333333'
const SECRET = '55555555-5555-4555-8555-555555555555'
const SHARED = '66666666-6666-4666-8666-666666666666'
const ROW = '11111111-1111-4111-8111-111111111111'
const CHANGE = '44444444-4444-4444-8444-444444444444'
const M1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** A workspace table in the person's second workspace. */
const VANS = '99999999-9999-4999-8999-999999999999'
const M2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const tableRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  name,
  icon: null,
  description: null,
  owner_member_id: M1,
  visibility: 'workspace',
  version: 3,
  position: 0,
  archived_at: null,
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-10T10:00:00Z',
  ...extra,
})
const column = (key: string, label: string, field_type: string, extra: Record<string, unknown> = {}) => ({
  id: `c-${key}`,
  workspace_id: WS,
  entity_type: 'data_row',
  table_id: RENTALS,
  key,
  label,
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})

type Rpc = (name: string, args: Record<string, unknown>) => RpcAnswer

/**
 * Rentals (a workspace table), another member's private table, and one
 * shared with the person by a grant. `visible_data_table_ids` answers as the
 * database would: the grant counts only when p_grants is true.
 */
function db(rpc?: Rpc) {
  return fakeTablesDb(
    {
      data_table: [
        tableRow(RENTALS, 'Equipment rentals'),
        tableRow(SECRET, 'Salaries', { visibility: 'private', owner_member_id: M2 }),
        tableRow(SHARED, 'Shared suppliers', { visibility: 'private', owner_member_id: M2 }),
      ],
      custom_field_definition: [
        column('item', 'Item', 'text'),
        column('due_back', 'Due back', 'date'),
        column('status', 'Status', 'select', { options: ['Out', 'Returned'] }),
        column('renter', 'Renter', 'person'),
      ],
      data_row: [{ id: ROW, workspace_id: WS, table_id: RENTALS, title: 'Robin', custom_fields: { status: 'Out' }, archived_at: null, position: 1 }],
      data_change: [],
      member: [
        { id: M1, workspace_id: WS, user_id: ME, role: 'member', display_name: 'Avery Stone' },
        { id: M2, workspace_id: WS, user_id: 'u-2', role: 'member', display_name: 'Jamie Park' },
      ],
      view: [],
    },
    (name, args) => {
      if (name === 'visible_data_table_ids') {
        const ids = (args.p_ids as string[]).filter((id) => id === RENTALS || id === VANS || (id === SHARED && args.p_grants === true))
        return { data: ids, error: null }
      }
      if (name === 'data_table_editable_by') return { data: false, error: null }
      if (rpc) return rpc(name, args)
      return { data: { version: 4, change_id: CHANGE, inserted_row_ids: ['new-row'], created_column_ids: {} }, error: null }
    },
  )
}

const call = async (tools: Record<string, unknown>, name: string, input: Record<string, unknown>) =>
  (await (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {})) as Record<string, unknown>

describe('the table tools: where they are registered', () => {
  const tools = createTableTools(ME, {} as never, WS)

  it('are the eight, in the Tables category, reads and internal writes on the board', () => {
    expect(Object.keys(tools).sort()).toEqual([...TABLE_TOOL_NAMES].sort())
    for (const name of TABLE_TOOL_NAMES) {
      const def = getToolDefinition(name)
      expect(def, name).toBeDefined()
      const read = ['find_tables', 'get_table', 'query_rows'].includes(name)
      expect(def!.sideEffect, name).toBe(read ? 'read' : 'internal-write')
      if (!read) expect(def!.writeTarget, name).toBe('board')
    }
  })

  it('read as reads and write as writes in report mode', () => {
    const mutating = getMutatingToolNames()
    for (const name of ['create_table', 'update_table_columns', 'write_rows', 'archive_rows', 'undo_table_change']) expect(mutating.has(name), name).toBe(true)
    for (const name of ['find_tables', 'get_table', 'query_rows']) expect(isReadShapedToolName(name), name).toBe(true)
  })

  it('no description is over what OpenAI takes', () => {
    for (const [name, t] of Object.entries(tools)) {
      expect(withToolGuide(name, (t as { description?: string }).description ?? '').length, name).toBeLessThanOrEqual(MAX_ADVERTISED_DESCRIPTION)
    }
  })

  it('points "track X for me" at create_table, and the writes at apply with undo', () => {
    const create = (tools.create_table as { description?: string }).description ?? ''
    expect(create).toContain('track')
    expect(create).toContain('find_tables first')
    const write = (tools.write_rows as { description?: string }).description ?? ''
    expect(write).toContain('they can undo it')
    expect(write).toContain("Don't ask first")
  })

  it('team chat reads tables but never writes them', () => {
    for (const name of ['find_tables', 'get_table', 'query_rows']) expect(isToolExcludedForSurface(name, 'team_chat'), name).toBe(false)
    for (const name of ['create_table', 'update_table_columns', 'write_rows', 'archive_rows', 'undo_table_change']) {
      expect(isToolExcludedForSurface(name, 'team_chat'), name).toBe(true)
      // The person's own text turn still writes them.
      expect(isToolExcludedForSurface(name, 'sms'), name).toBe(false)
    }
  })
})

describe('find_tables and get_table: only what the person can read', () => {
  it('lists the workspace table and the one shared with the person, never another member\'s private one', async () => {
    const f = db()
    const out = await call(createTableTools(ME, f.client, WS), 'find_tables', {})
    const names = (out.tables as Array<{ name: string }>).map((t) => t.name)
    expect(names).toEqual(['Equipment rentals', 'Shared suppliers'])
    expect((out.tables as Array<{ columns: string[] }>)[0].columns).toContain('Due back (date)')
  })

  it("on a guest's turn a grant opens nothing: the shared table is not there, and the fence asks without grants", async () => {
    const f = db()
    const tools = createTableTools(ME, f.client, WS, false, 'session', false, true)
    const out = await call(tools, 'find_tables', {})
    expect((out.tables as Array<{ name: string }>).map((t) => t.name)).toEqual(['Equipment rentals'])
    expect(f.rpcCalls.find((c) => c.name === 'visible_data_table_ids')?.args.p_grants).toBe(false)
    const shared = await call(tools, 'get_table', { table: SHARED })
    expect(shared.success).toBe(false)
  })

  it('a private table of someone else is not found by id or by name, and the refusal names only readable tables', async () => {
    const tools = createTableTools(ME, db().client, WS)
    expect((await call(tools, 'get_table', { table: SECRET })).success).toBe(false)
    const byName = await call(tools, 'get_table', { table: 'Salaries' })
    expect(byName.success).toBe(false)
    expect(String(byName.error)).not.toContain('Salaries (')
    expect(String(byName.error)).toContain('Equipment rentals')
  })

  it('reads one table: columns with their types and options, and whether the person can change it', async () => {
    const out = await call(createTableTools(ME, db().client, WS), 'get_table', { table: 'equipment rentals' })
    const table = out.table as { columns: Array<{ name: string; type: string; options?: string[] }>; can_edit: boolean; row_count: number }
    expect(table.columns.map((c) => c.name)).toEqual(['Name', 'Item', 'Due back', 'Status', 'Renter'])
    expect(table.columns.find((c) => c.name === 'Status')?.options).toEqual(['Out', 'Returned'])
    expect(table.can_edit).toBe(true)
    expect(table.row_count).toBe(1)
  })
})

describe('write_rows: one batch, values by column name, the person named', () => {
  it('adds a row by column name and changes one by its name, coerced to each column', async () => {
    const f = db()
    const out = await call(createTableTools(ME, f.client, WS), 'write_rows', {
      table: 'Equipment rentals',
      rows: [
        { name: 'Robin (tile saw)', values: { Item: 'Tile saw', 'Due back': '2026-11-20', status: 'out', Renter: 'me' } },
        { match: 'robin', values: { Status: 'Returned' } },
      ],
      because: 'Robin texted about the saw',
    })
    expect(out.success).toBe(true)
    const apply = f.rpcCalls.find((c) => c.name === 'apply_data_ops')!
    expect(apply.args).toMatchObject({ p_table_id: RENTALS, p_base_version: null, p_source: 'agent', p_reason: 'Robin texted about the saw', p_as_user: ME })
    expect(apply.args).not.toHaveProperty('p_grants')
    expect(apply.args.p_ops).toEqual([
      { op: 'insert_rows', rows: [{ title: 'Robin (tile saw)', values: { item: 'Tile saw', due_back: '2026-11-20', status: 'Out', renter: M1 } }] },
      { op: 'update_row', row_id: ROW, values: { status: 'Returned' } },
    ])
    expect(String(out.message)).toContain('The person can undo it')
  })

  it('refuses a value that does not fit, naming the column, and writes nothing', async () => {
    const f = db()
    const out = await call(createTableTools(ME, f.client, WS), 'write_rows', { table: RENTALS, rows: [{ name: 'Robin', values: { 'Due back': 'next week' } }] })
    expect(out).toMatchObject({ success: false })
    expect(String(out.error)).toContain('Due back')
    expect(f.rpcCalls.some((c) => c.name === 'apply_data_ops')).toBe(false)
  })

  it('an unknown column lists the table\'s columns', async () => {
    const out = await call(createTableTools(ME, db().client, WS), 'write_rows', { table: RENTALS, rows: [{ name: 'Robin', values: { Deposit: 50 } }] })
    expect(String(out.error)).toContain('Its columns: Name, Item, Due back, Status, Renter')
  })

  it("on a guest's turn the batch carries no grants for the database (530)", async () => {
    const f = db()
    const out = await call(createTableTools(ME, f.client, WS, false, 'session', false, true), 'write_rows', { table: RENTALS, rows: [{ name: 'Robin' }] })
    expect(out.success).toBe(true)
    expect(f.rpcCalls.find((c) => c.name === 'apply_data_ops')!.args.p_grants).toBe(false)
  })

  it('a table reached only by a grant changes only on the person\'s own attended turn', async () => {
    const f = db()
    // An unattended turn (editGrants false): refused before any write.
    const out = await call(createTableTools(ME, f.client, WS, false, 'session', false, false), 'write_rows', { table: SHARED, rows: [{ name: 'Acme' }] })
    expect(out.success).toBe(false)
    expect(String(out.error)).toContain('shared with the person')
    // Attended, but the grant is to view: the database's own answer refuses it.
    const viewOnly = await call(createTableTools(ME, f.client, WS, false, 'session', true, false), 'write_rows', { table: SHARED, rows: [{ name: 'Acme' }] })
    expect(String(viewOnly.error)).toContain('can view Shared suppliers but not change it')
    expect(f.rpcCalls.some((c) => c.name === 'apply_data_ops')).toBe(false)
  })
})

describe('create_table: typed columns and starter rows in one batch', () => {
  it('makes the keys, maps the starter rows by column name, starts with no blank rows, and says why', async () => {
    const f = db((name) =>
      name === 'create_data_table' ? { data: { table_id: 'new-table', version: 1, change_id: CHANGE, inserted_row_ids: ['r1'], created_column_ids: {} }, error: null } : { data: null, error: null },
    )
    const out = await call(createTableTools(ME, f.client, WS), 'create_table', {
      name: 'Equipment rentals',
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Due back', type: 'date' },
        { name: 'Status', type: 'select', options: ['Out', 'Returned'] },
        { name: 'Deposit', type: 'currency', currency: 'usd' },
      ],
      rows: [{ name: 'Robin', values: { Item: 'Tile saw', 'Due back': '2026-11-20', Status: 'Out', Deposit: 50 } }],
      because: 'The person asked to track rentals',
    })
    expect(out.success).toBe(true)
    const create = f.rpcCalls.find((c) => c.name === 'create_data_table')!
    expect(create.args).toMatchObject({ p_workspace_id: WS, p_name: 'Equipment rentals', p_source: 'agent', p_as_user: ME, p_reason: 'The person asked to track rentals' })
    const ops = create.args.p_ops as Array<Record<string, unknown>>
    expect(ops.filter((o) => o.op === 'create_column').map((o) => o.key)).toEqual(['item', 'due_back', 'status', 'deposit'])
    expect(ops.find((o) => o.key === 'deposit')?.config).toEqual({ currency: 'USD' })
    expect(ops.filter((o) => o.op === 'insert_rows')).toEqual([
      { op: 'insert_rows', rows: [{ title: 'Robin', values: { item: 'Tile saw', due_back: '2026-11-20', status: 'Out', deposit: { amount: 50, currency: 'USD' } } }] },
    ])
  })

  it('a table with no rows given starts empty', async () => {
    const f = db((name) => (name === 'create_data_table' ? { data: { table_id: 't', version: 1, change_id: CHANGE, inserted_row_ids: [], created_column_ids: {} }, error: null } : { data: null, error: null }))
    await call(createTableTools(ME, f.client, WS), 'create_table', { name: 'Suppliers', columns: [{ name: 'Phone', type: 'phone' }] })
    const ops = f.rpcCalls.find((c) => c.name === 'create_data_table')!.args.p_ops as Array<Record<string, unknown>>
    expect(ops.some((o) => o.op === 'insert_rows')).toBe(false)
  })
})

describe('query_rows: the views engine\'s filters, by column name', () => {
  it('"which rentals are overdue": a date filter before today, in the person\'s day, and a select filter', async () => {
    hoisted.queryRows.mockResolvedValueOnce({
      rows: [{ id: ROW, table_id: RENTALS, title: 'Robin', custom_fields: { status: 'Out', due_back: '2026-11-01', renter: M1 }, position: 1, archived_at: null, created_at: '', updated_at: '' }],
      hasMore: false,
    })
    const out = await call(createTableTools(ME, db().client, WS, false, 'session', false, false, 'UTC'), 'query_rows', {
      table: 'Equipment rentals',
      filters: [
        { column: 'Due back', operator: 'lt', value: 'today' },
        { column: 'Status', operator: 'is', value: 'Out' },
      ],
      sort: [{ column: 'Due back' }],
    })
    const [, ws, tableId, , opts] = hoisted.queryRows.mock.calls[0]
    expect([ws, tableId]).toEqual([WS, RENTALS])
    expect(opts.filters).toEqual([
      { id: 'agent-0', field: 'custom_fields.due_back', operator: 'lt', value: new Date().toISOString().slice(0, 10) },
      { id: 'agent-1', field: 'custom_fields.status', operator: 'is', value: 'Out' },
    ])
    expect(opts.ordering).toEqual([{ field: 'custom_fields.due_back', direction: 'asc' }])
    expect(opts.userId).toBe(ME)
    expect(opts.timeZone).toBe('UTC')
    expect(out.rows).toEqual([{ id: ROW, name: 'Robin', values: { Status: 'Out', 'Due back': '2026-11-01', Renter: 'Avery Stone' } }])
  })
})

describe('undo_table_change', () => {
  it('takes back the change it names, as the person, from the agent', async () => {
    const f = db()
    f.rows.data_change.push({
      id: CHANGE,
      workspace_id: WS,
      table_id: RENTALS,
      version: 3,
      changes: [{ op: 'update_row', row_id: ROW, fields: { 'values.status': { from: 'Returned', to: 'Out' } } }],
      undo_of: null,
      undone_at: null,
      created_at: '2026-11-10T10:00:00Z',
    })
    const out = await call(createTableTools(ME, f.client, WS), 'undo_table_change', { table: RENTALS, change_id: CHANGE })
    expect(out.success).toBe(true)
    const apply = f.rpcCalls.find((c) => c.name === 'apply_data_ops')!
    expect(apply.args).toMatchObject({ p_undo_of: CHANGE, p_source: 'agent', p_as_user: ME })
    expect(apply.args.p_ops).toEqual([{ op: 'update_row', row_id: ROW, values: { status: 'Returned' } }])
  })
})

/** A change to the rentals table, by `actor`, `minutesAgo` minutes ago. */
function change(id: string, actor: string, minutesAgo: number) {
  return {
    id,
    workspace_id: WS,
    table_id: RENTALS,
    version: 100 - minutesAgo,
    actor_user_id: actor,
    source: actor === ME ? 'agent' : 'person',
    reason: null,
    changes: [{ op: 'update_row', row_id: ROW, fields: { 'values.status': { from: 'Returned', to: 'Out' } } }],
    undo_of: null,
    undone_at: null,
    created_at: new Date(Date.UTC(2026, 10, 10, 10, 60 - minutesAgo)).toISOString(),
  }
}

describe('"undo that" with no change_id: the person\'s own latest change, never a teammate\'s', () => {
  it("undoes the person's latest change when nothing newer is a teammate's", async () => {
    const f = db()
    f.rows.data_change.push(change(CHANGE, ME, 5), change('77777777-7777-4777-8777-777777777777', ME, 30))
    const out = await call(createTableTools(ME, f.client, WS), 'undo_table_change', { table: RENTALS })
    expect(out.success).toBe(true)
    expect(f.rpcCalls.find((c) => c.name === 'apply_data_ops')!.args.p_undo_of).toBe(CHANGE)
  })

  it('asks which one, listing the latest with ids, when a teammate changed the table after it', async () => {
    const f = db()
    const theirs = '88888888-8888-4888-8888-888888888888'
    f.rows.data_change.push(change(theirs, 'u-2', 2), change(CHANGE, ME, 5))
    const out = await call(createTableTools(ME, f.client, WS), 'undo_table_change', { table: RENTALS })
    expect(out).toMatchObject({ success: false, needs_change_id: true })
    expect((out.changes as Array<{ change_id: string; by: string }>).map((c) => [c.change_id, c.by])).toEqual([
      [theirs, 'a teammate'],
      [CHANGE, 'the person'],
    ])
    expect(f.rpcCalls.some((c) => c.name === 'apply_data_ops')).toBe(false)
  })

  it("says so when the person has nothing to undo, a teammate's change alone there", async () => {
    const f = db()
    f.rows.data_change.push(change('88888888-8888-4888-8888-888888888888', 'u-2', 2))
    const out = await call(createTableTools(ME, f.client, WS), 'undo_table_change', { table: RENTALS })
    expect(out).toMatchObject({ success: false })
    expect(f.rpcCalls.some((c) => c.name === 'apply_data_ops')).toBe(false)
  })
})

describe("day words are the person's dates, in their zone", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('adds a calendar day, not 24 hours, across a DST change', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 11:30 pm Saturday March 7 in Los Angeles; the clocks go forward that night.
    vi.setSystemTime(new Date('2026-03-08T07:30:00Z'))
    expect(dayWordDate('tomorrow', 'America/Los_Angeles')).toBe('2026-03-08')
    expect(dayWordDate('today', 'America/Los_Angeles')).toBe('2026-03-07')
    // 11:30 pm Sunday November 1, the night the clocks went back.
    vi.setSystemTime(new Date('2026-11-02T07:30:00Z'))
    expect(dayWordDate('yesterday', 'America/Los_Angeles')).toBe('2026-10-31')
    expect(dayWordDate('next week', 'America/Los_Angeles')).toBeNull()
  })

  it('a Los Angeles evening\'s "tomorrow" is the next LA day, read from the saved zone when the turn has none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 8:30 pm November 10 in Los Angeles: already November 11 in UTC.
    vi.setSystemTime(new Date('2026-11-11T04:30:00Z'))
    const f = db()
    f.rows.member[0].time_zone = 'America/Los_Angeles'
    await call(createTableTools(ME, f.client, WS), 'write_rows', { table: RENTALS, rows: [{ name: 'Robin', values: { 'Due back': 'tomorrow' } }] })
    const ops = f.rpcCalls.find((c) => c.name === 'apply_data_ops')!.args.p_ops as Array<{ rows: Array<{ values: Record<string, unknown> }> }>
    expect(ops[0].rows[0].values.due_back).toBe('2026-11-11')
  })

  it('an overdue query compares with the LA day and passes the zone to the views engine', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T04:30:00Z'))
    hoisted.queryRows.mockResolvedValueOnce({ rows: [], hasMore: false })
    const f = db()
    f.rows.member[0].time_zone = 'America/Los_Angeles'
    await call(createTableTools(ME, f.client, WS), 'query_rows', { table: RENTALS, filters: [{ column: 'Due back', operator: 'lt', value: 'today' }] })
    const opts = hoisted.queryRows.mock.calls.at(-1)![4]
    expect(opts.filters[0].value).toBe('2026-11-10')
    expect(opts.timeZone).toBe('America/Los_Angeles')
  })

  it("the browser's zone this turn wins over the saved one", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T04:30:00Z'))
    const f = db()
    f.rows.member[0].time_zone = 'America/Los_Angeles'
    await call(createTableTools(ME, f.client, WS, false, 'session', false, false, 'Europe/Berlin'), 'write_rows', { table: RENTALS, rows: [{ name: 'Robin', values: { 'Due back': 'today' } }] })
    const ops = f.rpcCalls.find((c) => c.name === 'apply_data_ops')!.args.p_ops as Array<{ rows: Array<{ values: Record<string, unknown> }> }>
    expect(ops[0].rows[0].values.due_back).toBe('2026-11-11')
  })
})

describe('names and workspaces', () => {
  it("never blanks an existing row's name", async () => {
    const f = db()
    const out = await call(createTableTools(ME, f.client, WS), 'write_rows', { table: RENTALS, rows: [{ match: 'Robin', name: '' }] })
    expect(out).toMatchObject({ success: false })
    expect(String(out.error)).toContain('keeps its name')
    expect(f.rpcCalls.some((c) => c.name === 'apply_data_ops')).toBe(false)
  })

  it('finds tables in another workspace the person belongs to, by its id, and in no other', async () => {
    const f = db()
    f.rows.member.push({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspace_id: 'ws-2', user_id: ME, role: 'member', display_name: 'Avery Stone' })
    f.rows.data_table.push(tableRow(VANS, 'Van bookings', { workspace_id: 'ws-2' }))
    const tools = createTableTools(ME, f.client, WS)
    const there = await call(tools, 'find_tables', { workspace_id: 'ws-2' })
    expect((there.tables as Array<{ name: string }>).map((t) => t.name)).toEqual(['Van bookings'])
    const byName = await call(tools, 'get_table', { table: 'Van bookings', workspace_id: 'ws-2' })
    expect(byName.success).toBe(true)
    expect((await call(tools, 'get_table', { table: 'Van bookings' })).success).toBe(false)
    expect(await call(tools, 'find_tables', { workspace_id: 'ws-nope' })).toMatchObject({ success: false, error: 'Workspace not found.' })
  })
})

describe('formulas and rollups (phase 6)', () => {
  it('create_table makes a formula after the columns it uses, stored by key', async () => {
    const f = db((name) => (name === 'create_data_table' ? { data: { table_id: 't', version: 1, change_id: CHANGE, inserted_row_ids: [], created_column_ids: {} }, error: null } : { data: null, error: null }))
    const out = await call(createTableTools(ME, f.client, WS), 'create_table', {
      name: 'Stock',
      columns: [
        { name: 'Qty', type: 'number' },
        { name: 'Unit price', type: 'currency' },
        { name: 'Value', type: 'formula', expression: '{Qty} * {Unit price}' },
      ],
    })
    expect(out.success).toBe(true)
    const ops = f.rpcCalls.find((c) => c.name === 'create_data_table')!.args.p_ops as Array<Record<string, unknown>>
    expect(ops.find((o) => o.key === 'value')).toMatchObject({ field_type: 'formula', config: { expression: '{#qty} * {#unit_price}' } })
  })

  it('a formula without its expression, or naming nothing, is refused and nothing is made', async () => {
    const f = db()
    const tools = createTableTools(ME, f.client, WS)
    expect(await call(tools, 'create_table', { name: 'Stock', columns: [{ name: 'Value', type: 'formula' }] })).toMatchObject({ success: false, error: expect.stringContaining('expression') })
    expect(await call(tools, 'create_table', { name: 'Stock', columns: [{ name: 'Value', type: 'formula', expression: '{Nope} * 2' }] })).toMatchObject({ success: false })
    expect(f.rpcCalls.some((c) => c.name === 'create_data_table')).toBe(false)
  })

  it('update_table_columns adds a rollup through a relation column, by name', async () => {
    const f = db()
    f.rows.custom_field_definition.push(column('jobs', 'Jobs', 'relation', { config: { target: { kind: 'deal' }, multiple: true } }))
    const out = await call(createTableTools(ME, f.client, WS), 'update_table_columns', {
      table: 'Equipment rentals',
      changes: [{ action: 'add', column: 'Job count', type: 'rollup', through: 'Jobs', aggregate: 'count' }],
    })
    expect(out.success).toBe(true)
    const apply = f.rpcCalls.find((c) => c.name === 'apply_data_ops')!
    expect((apply.args.p_ops as Array<Record<string, unknown>>)[0]).toMatchObject({ op: 'create_column', field_type: 'rollup', config: { relation: 'jobs', fn: 'count', field: null } })
  })

  it('query_rows works formulas out for the person, without grants on a guest’s turn, and returns their cells', async () => {
    const f = db()
    f.rows.custom_field_definition.push(column('days', 'Days out', 'formula', { config: { expression: 'days_between({#due_back}, today())' } }))
    hoisted.queryRows.mockResolvedValueOnce({
      rows: [{ id: ROW, table_id: RENTALS, title: 'Robin', custom_fields: { status: 'Out' }, computed: { days: { value: 4 } }, position: 1, archived_at: null, created_at: '', updated_at: '' }],
      hasMore: false,
    })
    const out = await call(createTableTools(ME, f.client, WS, false, 'session', false, true, 'UTC'), 'query_rows', { table: 'Equipment rentals' })
    const opts = hoisted.queryRows.mock.calls.at(-1)![4]
    expect(opts.computed).toEqual({ workspaceId: WS, userId: ME, grants: false, timeZone: 'UTC' })
    expect((out.rows as Array<{ values: Record<string, unknown> }>)[0].values).toMatchObject({ Status: 'Out', 'Days out': 4 })
  })
})
