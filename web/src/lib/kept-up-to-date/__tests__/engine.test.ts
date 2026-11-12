/**
 * The kept-up-to-date engine (engine.ts, migration 539). Pinned:
 *   • candidates: rows a relation links to the source's contacts or
 *     companies, in the source's workspace only, in live tables the person
 *     may change (a private table of another member and a view-only one are
 *     left out), never archived, never made after the source;
 *   • changes: a select's other options, a checkbox flipped, the dates and
 *     amounts the source names; never a value this engine set before, never a
 *     select set back to what the person moved it away from, never a to-do
 *     closed before;
 *   • apply: the record row first (one change per source and record: a retry
 *     changes nothing twice), the batch as the person's agent with source
 *     and a reason naming only where from (no words, sender or domain), only while the row holds what was
 *     read; a required-when refusal is no change and the row goes; one
 *     message in the home thread and one log line;
 *   • the pass: nothing without a home thread, a source that changed
 *     something before changes nothing again, at most MAX_KEPT_PER_PASS,
 *     unreadable (539 missing) changes nothing;
 *   • Undo: a row's batch back through undoChange, a to-do back where it
 *     was; marked once, the message rewritten; never re-applied after.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { OpenTodo } from '@/lib/email/action-done-from-mail'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import type { RecordKeptUpToDateInput, RecordKeptUpToDateValue } from '@/lib/ai/decisions/tasks/record-kept-up-to-date'
import {
  MAX_KEPT_PER_PASS,
  applyKeptChange,
  keptPass,
  keptReason,
  linkedTaskIds,
  pendingProposalIds,
  planChanges,
  readPriorChanges,
  readRowCandidates,
  undoKeptChange,
  type KeptPeople,
  type KeptSourceItem,
  type PlannedChange,
  type RowCandidate,
} from '../engine'
import { KEPT_PART_TYPE } from '../part'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('no service client in tests') } }))

const WS = 'ws'
const SCOPE = { workspaceId: WS, userId: 'u' }
const T0 = '2026-10-01T10:00:00.000Z'
const AT = '2026-11-10T15:00:00.000Z'
const NOW_MS = Date.parse('2026-11-11T12:00:00.000Z')

const people = (): KeptPeople => ({ contactIds: ['c-dana'], companyIds: ['co-acme'], names: new Map([['c-dana', 'Dana Reyes'], ['co-acme', 'Acme Robotics']]) })

const item = (over: Partial<KeptSourceItem> = {}): KeptSourceItem => ({
  source: 'email',
  ref: 'thread-1:msg-1',
  label: 'acme.example',
  atIso: AT,
  header: { kind: 'email', from: 'Dana Reyes <dana@acme.example>', subject: 'Re: renewal' },
  text: 'Good news. We signed the renewal this morning.\nCan we push the kickoff to March?',
  people: people(),
  tasks: false,
  ...over,
})

const column = (table: string, key: string, field_type: string, over: Record<string, unknown> = {}) => ({
  id: `${table}-${key}`, workspace_id: WS, entity_type: 'data_row', table_id: table, key, label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
  field_type, options: [], config: {}, position: 0, deleted_at: null, created_at: T0, ...over,
})

function seed(db: FakeSupabase) {
  db.seed('member', [{ id: 'mem-me', workspace_id: WS, user_id: 'u' }])
  db.seed('chat_conversations', [{ id: 'home', user_id: 'u', workspace_id: WS, is_home: true }])
  db.seed('data_table', [
    { id: 't-pipe', workspace_id: WS, name: 'Pipeline', version: 7, archived_at: null },
    { id: 't-private', workspace_id: WS, name: 'Sam’s private deals', version: 1, archived_at: null },
    { id: 't-view', workspace_id: WS, name: 'Shared to view', version: 1, archived_at: null },
    { id: 't-other', workspace_id: 'other', name: 'Another workspace', version: 1, archived_at: null },
  ])
  db.seed('custom_field_definition', [
    column('t-pipe', 'stage', 'select', { options: ['Lead', 'Proposal', 'Won', 'Lost'], position: 0 }),
    column('t-pipe', 'close_date', 'date', { position: 1 }),
    column('t-pipe', 'value', 'currency', { config: { currency: 'USD' }, position: 2 }),
    column('t-pipe', 'signed', 'checkbox', { position: 3 }),
    column('t-pipe', 'contacts', 'relation', { config: { target: { kind: 'contact' } }, position: 4 }),
    column('t-pipe', 'notes', 'text', { position: 5 }),
    column('t-private', 'stage', 'select', { options: ['Open', 'Won'] }),
    column('t-view', 'stage', 'select', { options: ['Open', 'Won'] }),
  ])
  const row = (id: string, table: string, over: Record<string, unknown> = {}) => ({
    id, table_id: table, workspace_id: WS, title: `Row ${id}`, custom_fields: { stage: 'Open' }, archived_at: null, created_at: T0, updated_at: T0, ...over,
  })
  db.seed('data_row', [
    row('r-acme', 't-pipe', { title: 'Acme renewal', custom_fields: { stage: 'Proposal', close_date: '2026-11-30', value: { amount: 40000, currency: 'USD' }, contacts: ['c-dana'] } }),
    row('r-private', 't-private'),
    row('r-view', 't-view'),
    row('r-other', 't-other', { workspace_id: 'other' }),
    row('r-archived', 't-pipe', { archived_at: T0 }),
    row('r-new', 't-pipe', { created_at: '2026-11-10T16:00:00.000Z' }),
  ])
  const link = (rowId: string, ws = WS, target = 'c-dana', type = 'contact') => ({ id: `l-${rowId}-${target}`, workspace_id: ws, source_type: 'data_row', source_id: rowId, target_type: type, target_id: target, relation: 'field_link' })
  db.seed('entity_link', [
    link('r-acme'), link('r-acme', WS, 'co-acme', 'company'), link('r-private'), link('r-view'), link('r-other', 'other'), link('r-archived'), link('r-new'),
    // A mention is not a relation.
    { id: 'l-mention', workspace_id: WS, source_type: 'data_row', source_id: 'r-view', target_type: 'contact', target_id: 'c-dana', relation: 'mentions' },
  ])
  db.seed('team', [{ id: 'team', workspace_id: WS }])
  db.seed('workflow_state', [
    { id: 'todo', team_id: 'team', category: 'unstarted', sort_order: 1, is_default: true },
    { id: 'backlog', team_id: 'team', category: 'backlog', sort_order: 0 },
    { id: 'done', team_id: 'team', category: 'completed', sort_order: 3 },
  ])
  db.seed('actions', [{ id: 'a1', workspace_id: WS, identifier: 'GEN-12', title: 'Send Dana the signed order form', team_id: 'team', status_id: 'backlog' }])
}

const editable = (args: Record<string, unknown>) => ({ data: args.p_table_id === 't-pipe' && args.p_user_id === 'u', error: null })

function fresh(): FakeSupabase {
  const db = makeFakeSupabase({ rpc: { data_table_editable_by: editable }, unique: { kept_change: ['source_ref'] } })
  seed(db)
  return db
}

/** `kept_change`'s reads and writes fail as they do before migration 539. */
function without539(db: FakeSupabase): FakeSupabase {
  return {
    ...db,
    from: (table: string) => {
      const q = db.from(table) as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'kept_change') return q
      const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.kept_change' in the schema cache" } }
      const chain: Record<string, unknown> = {}
      for (const k of ['select', 'eq', 'in', 'is', 'limit', 'order', 'insert']) chain[k] = () => chain
      chain.maybeSingle = async () => missing
      chain.single = async () => missing
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(missing).then(ok)
      return chain
    },
  }
}

const task = (over: Partial<OpenTodo> = {}): OpenTodo => ({
  id: 'a1', identifier: 'GEN-12', title: 'Send Dana the signed order form', description: null, dueAt: null, teamId: 'team', statusId: 'backlog', createdAt: T0, ...over,
})

async function acmeRow(db: FakeSupabase): Promise<RowCandidate> {
  const rows = await readRowCandidates(db as never, SCOPE, people(), AT)
  return rows!.find((r) => r.id === 'r-acme')!
}

const applied = (changeId = 'chg-1') => vi.fn(async () => ({ ok: true as const, value: { version: 8, change_id: changeId, inserted_row_ids: [], created_column_ids: {} } }))

describe('readRowCandidates', () => {
  it('only rows a relation links to the source’s people, in this workspace, in live tables the person may change, made before the source', async () => {
    const db = fresh()
    const rows = await readRowCandidates(db as never, SCOPE, people(), AT)
    expect(rows?.map((r) => r.id)).toEqual(['r-acme'])
    expect(rows?.[0]).toMatchObject({ tableId: 't-pipe', tableName: 'Pipeline', title: 'Acme renewal', linked: expect.arrayContaining(['Dana Reyes', 'Acme Robotics']) })
    expect(rows?.[0].columns.map((c) => c.key)).toEqual(['stage', 'close_date', 'value', 'signed', 'contacts', 'notes'])
    // Editability is asked for the person, per table.
    expect(db.rpcCalls.filter((c) => c.fn === 'data_table_editable_by').every((c) => c.args.p_user_id === 'u')).toBe(true)
  })

  it('nobody involved, no rows', async () => {
    expect(await readRowCandidates(fresh() as never, SCOPE, { contactIds: [], companyIds: [], names: new Map() }, AT)).toEqual([])
  })

  it('another person’s editability is never borrowed: a stranger gets nothing', async () => {
    expect(await readRowCandidates(fresh() as never, { workspaceId: WS, userId: 'stranger' }, people(), AT)).toEqual([])
  })
})

describe('planChanges', () => {
  it('a select’s other options, a checkbox, the dates and amounts named; nothing for text or relations', async () => {
    const row = await acmeRow(fresh())
    const { records, changes } = planChanges(
      [{ kind: 'row', row }],
      { dates: [{ value: '2027-03-31', phrase: 'March', sentence: 1 }], amounts: [{ amount: 48000, currency: 'USD', phrase: '$48,000', sentence: 0 }, { amount: 9, currency: 'EUR', phrase: '€9', sentence: 0 }], numbers: [] },
      { tasks: new Set(), values: new Set() },
    )
    expect(records).toHaveLength(1)
    const summary = changes.map((c) => (c.kind === 'row_set' ? `${c.key}=${JSON.stringify(c.to)}` : 'done'))
    expect(summary).toEqual(['stage="Lead"', 'stage="Won"', 'stage="Lost"', 'close_date="2027-03-31"', 'value={"amount":48000,"currency":"USD"}', 'signed=true'])
    expect(changes.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
  })

  it('never a value set before or one the person moved away from, never a to-do closed before', async () => {
    const row = await acmeRow(fresh())
    const prior = { tasks: new Set(['a1']), values: new Set([`r-acme|stage|"Won"`, `r-acme|signed|true`]) }
    const { records, changes } = planChanges([{ kind: 'row', row }, { kind: 'task', task: task() }], { dates: [], amounts: [], numbers: [] }, prior)
    expect(changes.map((c) => (c.kind === 'row_set' ? `${c.key}=${String(c.to)}` : 'done'))).toEqual(['stage=Lead', 'stage=Lost'])
    expect(records.map((r) => r.kind)).toEqual(['row'])
  })

  it('rows before to-dos, a to-do is one change: done', async () => {
    const row = await acmeRow(fresh())
    const { records, changes } = planChanges([{ kind: 'task', task: task() }, { kind: 'row', row }], { dates: [], amounts: [], numbers: [] }, { tasks: new Set(), values: new Set() })
    expect(records.map((r) => r.kind)).toEqual(['row', 'task'])
    expect(changes.at(-1)).toMatchObject({ kind: 'task_done', record: 1 })
  })
})

describe('readPriorChanges', () => {
  it('reads this engine’s changes and the person’s own moves away from a value; 539 missing reads as unreadable', async () => {
    const db = fresh()
    db.seed('kept_change', [
      { id: 'k0', workspace_id: WS, user_id: 'u', source: 'email', source_ref: 'old', record_type: 'data_row', record_id: 'r-acme', table_id: 't-pipe', field_key: 'value', to_value: { amount: 1, currency: 'USD' } },
      { id: 'k1', workspace_id: WS, user_id: 'u', source: 'sms', source_ref: 'old2', record_type: 'action', record_id: 'a1', table_id: null, field_key: null },
    ])
    db.seed('data_change', [
      { id: 'dc1', workspace_id: WS, table_id: 't-pipe', source: 'person', created_at: '2026-11-01T00:00:00.000Z', changes: [{ op: 'update_row', row_id: 'r-acme', fields: { 'values.stage': { from: 'Won', to: 'Proposal' } } }] },
      { id: 'dc2', workspace_id: WS, table_id: 't-pipe', source: 'email', created_at: '2026-11-01T00:00:00.000Z', changes: [{ op: 'update_row', row_id: 'r-acme', fields: { 'values.stage': { from: 'Lost', to: 'Proposal' } } }] },
      // Another row's history is not this row's.
      { id: 'dc3', workspace_id: WS, table_id: 't-pipe', source: 'person', created_at: '2026-11-01T00:00:00.000Z', changes: [{ op: 'update_row', row_id: 'r-new', fields: { 'values.stage': { from: 'Lead', to: 'Open' } } }] },
    ])
    const prior = await readPriorChanges(db as never, SCOPE, [{ id: 'r-acme', tableId: 't-pipe' }], ['a1'], NOW_MS)
    expect([...prior!.tasks]).toEqual(['a1'])
    expect([...prior!.values].sort()).toEqual([`r-acme|stage|"Won"`, `r-acme|value|{"amount":1,"currency":"USD"}`])
    expect(await readPriorChanges(without539(db) as never, SCOPE, [{ id: 'r-acme', tableId: 't-pipe' }], [], NOW_MS)).toBeNull()
  })
})

describe('applyKeptChange', () => {
  let db: FakeSupabase
  let row: RowCandidate
  let won: Extract<PlannedChange, { kind: 'row_set' }>
  beforeEach(async () => {
    db = fresh()
    row = await acmeRow(db)
    won = { id: 'c2', kind: 'row_set', record: 0, row, key: 'stage', label: 'Stage', type: 'select', from: 'Proposal', to: 'Won' }
  })

  it('records it, applies one batch as the person’s agent with a reason naming only where from, then one message and one log line', async () => {
    const apply = applied()
    const writeMessage = vi.fn(async (..._args: unknown[]) => true)
    const appendLog = vi.fn(async () => true)
    const result = await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed the renewal this morning.' }, { apply, writeMessage, appendLog })
    expect(result).toMatchObject({ status: 'changed' })
    expect(apply).toHaveBeenCalledWith(db, WS, 't-pipe', { baseVersion: 7, ops: [{ op: 'update_row', row_id: 'r-acme', values: { stage: 'Won' } }] }, {
      userId: 'u', asUserId: 'u', source: 'email', reason: 'Kept up to date from an email',
    })
    // The table's history carries none of the mail: no words, no sender, no domain.
    const reason = (apply.mock.calls[0] as unknown[])[4] as { reason: string }
    for (const word of ['signed', 'renewal', 'acme', 'Dana', '“']) expect(reason.reason).not.toContain(word)
    const kept = db.rows('kept_change')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ source: 'email', source_ref: 'thread-1:msg-1', source_label: 'acme.example', record_type: 'data_row', record_id: 'r-acme', table_id: 't-pipe', field_key: 'stage', from_value: 'Proposal', to_value: 'Won', data_change_id: 'chg-1', evidence: 'We signed the renewal this morning.' })
    expect(writeMessage).toHaveBeenCalledWith(db, { ...SCOPE, conversationId: 'home' }, expect.objectContaining({ record_type: 'data_row', target_id: 'r-acme', title: 'Acme renewal', table: 'Pipeline', field: 'Stage', from: 'Proposal', to: 'Won', source: 'email', evidence: 'We signed the renewal this morning.' }))
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ kind: 'kept_up_to_date', refType: 'data_row', refId: 'r-acme', line: expect.stringContaining('Updated Acme renewal: Stage → Won, from an email from acme.example') }), db)
  })

  it('a retry of the same source changes nothing twice', async () => {
    const apply = applied()
    const args = { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }
    expect((await applyKeptChange(db as never, args, { apply, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })).status).toBe('changed')
    expect((await applyKeptChange(db as never, args, { apply, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })).status).toBe('already')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('a required-when refusal is no change: the row goes, no message', async () => {
    const apply = vi.fn(async () => ({ ok: false as const, reason: 'invalid' as const, error: 'Close reason is needed when Stage is Won (row “Acme renewal”).' }))
    const writeMessage = vi.fn(async (..._args: unknown[]) => true)
    expect((await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }, { apply, writeMessage })).status).toBe('refused')
    expect(db.rows('kept_change')).toHaveLength(0)
    expect(writeMessage).not.toHaveBeenCalled()
  })

  it('changed since it was read: left alone, the row goes', async () => {
    db.rows('data_row').find((r) => r.id === 'r-acme')!.custom_fields = { stage: 'Lost' }
    const apply = applied()
    expect((await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }, { apply })).status).toBe('moved')
    expect(apply).not.toHaveBeenCalled()
    expect(db.rows('kept_change')).toHaveLength(0)
  })

  it('a teammate’s write elsewhere in the table: read again and retried once', async () => {
    const apply = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'conflict', error: 'changed', version: 8 })
      .mockResolvedValueOnce({ ok: true, value: { version: 9, change_id: 'chg-2', inserted_row_ids: [], created_column_ids: {} } })
    const result = await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }, { apply, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(result.status).toBe('changed')
    expect(apply).toHaveBeenCalledTimes(2)
    expect(db.rows('kept_change')[0].data_change_id).toBe('chg-2')
  })

  it('no source is quoted in the table’s history: what and where from only', () => {
    expect(keptReason('email')).toBe('Kept up to date from an email')
    expect(keptReason('capture')).toBe('Kept up to date from a meeting')
    expect(keptReason('sms')).toBe('Kept up to date from a text')
  })

  it('a to-do: its team’s done state, only while it sits where it was read, a flow fired as an agent’s change', async () => {
    const emit = vi.fn()
    const change: PlannedChange = { id: 'c1', kind: 'task_done', record: 0, task: task() }
    const result = await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item({ source: 'capture', ref: 'cap-1', label: null }), change, evidence: 'I sent Dana the signed order form.' }, { emit, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(result.status).toBe('changed')
    expect(db.rows('actions')[0].status_id).toBe('done')
    expect(db.rows('kept_change')[0]).toMatchObject({ record_type: 'action', record_id: 'a1', prior_status_id: 'backlog', done_status_id: 'done' })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'a1', fromStatusId: 'backlog', toStatusId: 'done', origin: { actor: 'agent', depth: 1 } }))
  })

  it('539 missing: nothing changes', async () => {
    const apply = applied()
    expect((await applyKeptChange(without539(db) as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }, { apply })).status).toBe('unavailable')
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('keptPass', () => {
  const decideWon = () =>
    vi.fn(async (input: RecordKeptUpToDateInput): Promise<DecisionResult<RecordKeptUpToDateValue>> => {
      const index = input.changes.findIndex((c) => c.field === 'Stage' && c.to === 'Won')
      return { status: 'accepted', value: { changeId: input.changes[index].id, evidence: 1 }, inferenceId: 'i', version: 'v' }
    })

  it('one source: the rows read, the decision put, the picked change applied with the picked sentence', async () => {
    const db = fresh()
    const decide = decideWon()
    const apply = applied()
    const writeMessage = vi.fn(async (..._args: unknown[]) => true)
    const pass = keptPass(db as never, { ...SCOPE, now: 'Tuesday' }, { decide, apply, writeMessage, appendLog: vi.fn(async () => true), nowMs: NOW_MS })
    expect(await pass.consider(item(), 'run-1')).toBe('changed')
    expect(pass.changed()).toBe(1)
    const input = decide.mock.calls[0][0]
    expect(input.sentences).toEqual(['Good news.', 'We signed the renewal this morning.', 'Can we push the kickoff to March?'])
    expect(input.records).toEqual([expect.objectContaining({ kind: 'row', title: 'Acme renewal', table: 'Pipeline', values: expect.objectContaining({ Stage: 'Proposal' }) })])
    // March, from the message's own date: that month's last day.
    expect(input.changes).toContainEqual(expect.objectContaining({ type: 'date', field: 'Close date', to: expect.stringContaining('Mar 31') }))
    expect(writeMessage.mock.calls[0][2] as object).toMatchObject({ evidence: 'We signed the renewal this morning.', to: 'Won' })
    // Considered again (a retried pass): the source changed something already.
    expect(await pass.consider(item(), 'run-1')).toBe('skipped')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('none picked, nothing changes', async () => {
    const db = fresh()
    const apply = applied()
    const decide = vi.fn(async (): Promise<DecisionResult<RecordKeptUpToDateValue>> => ({ status: 'accepted', value: { changeId: null, evidence: null }, inferenceId: 'i', version: 'v' }))
    expect(await keptPass(db as never, { ...SCOPE, now: 'Tuesday' }, { decide, apply }).consider(item())).toBe('none')
    expect(apply).not.toHaveBeenCalled()
  })

  it('no home thread, no candidate, or 539 missing: skipped before any decision', async () => {
    const decide = decideWon()
    const db = fresh()
    expect(await keptPass(db as never, { ...SCOPE, now: 'x' }, { decide, homeThread: async () => null }).consider(item())).toBe('skipped')
    expect(await keptPass(db as never, { ...SCOPE, now: 'x' }, { decide }).consider(item({ people: { contactIds: [], companyIds: [], names: new Map() } }))).toBe('skipped')
    expect(await keptPass(without539(db) as never, { ...SCOPE, now: 'x' }, { decide }).consider(item())).toBe('skipped')
    expect(decide).not.toHaveBeenCalled()
  })

  it('to-dos only when the source says so, never one made after it or one it must leave alone', async () => {
    const db = fresh()
    const decide = vi.fn(async (_input: RecordKeptUpToDateInput): Promise<DecisionResult<RecordKeptUpToDateValue>> => ({ status: 'accepted', value: { changeId: null, evidence: null }, inferenceId: 'i', version: 'v' }))
    const todos = [task(), task({ id: 'late', title: 'Made from this meeting', createdAt: '2026-11-10T16:00:00.000Z' }), task({ id: 'carded', title: 'On the meeting’s card' })]
    const readTodos = vi.fn(async () => todos)
    const pass = keptPass(db as never, { ...SCOPE, now: 'x' }, { decide, readTodos })
    await pass.consider(item({ tasks: false, ref: 'a' }))
    expect(readTodos).not.toHaveBeenCalled()
    db.seed('proposed_change', [{ id: 'pc1', workspace_id: WS, capture_id: 'cap-1', status: 'pending', entity_type: 'action', entity_id: 'carded' }])
    await pass.consider(item({ tasks: 'all', ref: 'b' }))
    expect(decide.mock.calls[1][0].records.filter((r) => r.kind === 'task').map((r) => r.title)).toEqual(['Send Dana the signed order form'])
  })

  it('an email or a text offers only the to-dos linked to its people; a stranger offers none', async () => {
    const db = fresh()
    const decide = vi.fn(async (_input: RecordKeptUpToDateInput): Promise<DecisionResult<RecordKeptUpToDateValue>> => ({ status: 'accepted', value: { changeId: null, evidence: null }, inferenceId: 'i', version: 'v' }))
    const todos = [task(), task({ id: 'a2', title: 'Renew the office lease' })]
    const linkedTasks = vi.fn(async () => new Set(['a1']))
    const pass = keptPass(db as never, { ...SCOPE, now: 'x' }, { decide, readTodos: async () => todos, linkedTasks, readRows: async () => [] })
    await pass.consider(item({ tasks: 'linked' }))
    expect(linkedTasks).toHaveBeenCalledWith(db, expect.objectContaining(SCOPE), expect.objectContaining({ contactIds: ['c-dana'] }), ['a1', 'a2'])
    expect(decide.mock.calls[0][0].records.map((r) => r.title)).toEqual(['Send Dana the signed order form'])
    // None linked, nothing to put beside it.
    expect(await keptPass(db as never, { ...SCOPE, now: 'x' }, { decide, readTodos: async () => todos, linkedTasks: async () => new Set(), readRows: async () => [] }).consider(item({ tasks: 'linked', ref: 'z' }))).toBe('skipped')
  })

  it('linkedTaskIds: an edge either way, or through the to-do’s project, in this workspace only', async () => {
    const db = fresh()
    db.seed('actions', [
      { id: 'a2', workspace_id: WS, project_id: 'p1' },
      { id: 'a3', workspace_id: WS, project_id: null },
      { id: 'a4', workspace_id: WS, project_id: null },
      { id: 'a5', workspace_id: WS, project_id: null },
    ])
    const edge = (id: string, ws: string, st: string, sid: string, tt: string, tid: string) => ({ id, workspace_id: ws, source_type: st, source_id: sid, target_type: tt, target_id: tid, relation: 'about' })
    db.seed('entity_link', [
      edge('e1', WS, 'action', 'a1', 'contact', 'c-dana'),
      edge('e2', WS, 'project', 'p1', 'company', 'co-acme'),
      edge('e3', WS, 'company', 'co-acme', 'action', 'a3'),
      edge('e4', 'other', 'action', 'a4', 'contact', 'c-dana'),
      edge('e5', WS, 'action', 'a5', 'contact', 'c-someone-else'),
    ])
    const ids = await linkedTaskIds(db as never, SCOPE, people(), ['a1', 'a2', 'a3', 'a4', 'a5'])
    expect([...ids!].sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('a record a pending proposal names is left to its card', async () => {
    const db = fresh()
    db.seed('proposed_change', [
      { id: 'pc1', workspace_id: WS, status: 'pending', entity_id: 'r-acme' },
      { id: 'pc2', workspace_id: WS, status: 'applied', entity_id: 'a1' },
      { id: 'pc3', workspace_id: 'other', status: 'pending', entity_id: 'a1' },
    ])
    expect([...(await pendingProposalIds(db as never, SCOPE, ['r-acme', 'a1']))!]).toEqual(['r-acme'])
    const decide = vi.fn()
    expect(await keptPass(db as never, { ...SCOPE, now: 'x' }, { decide }).consider(item())).toBe('skipped')
    expect(decide).not.toHaveBeenCalled()
  })

  it('at most MAX_KEPT_PER_PASS changes a pass', async () => {
    const db = fresh()
    const applyChange = vi.fn(async () => ({ status: 'changed' as const, recordId: 'k' }))
    const row = await acmeRow(fresh())
    let n = 0
    const pass = keptPass(db as never, { ...SCOPE, now: 'x' }, { decide: decideWon(), applyChange, readRows: async () => [{ ...row, id: `r-${n++}` }] })
    for (let i = 0; i < MAX_KEPT_PER_PASS + 2; i++) await pass.consider(item({ ref: `m${i}` }))
    expect(applyChange).toHaveBeenCalledTimes(MAX_KEPT_PER_PASS)
    expect(pass.changed()).toBe(MAX_KEPT_PER_PASS)
  })
})

describe('undoKeptChange', () => {
  async function changeWon(db: FakeSupabase) {
    const row = await acmeRow(db)
    const won: PlannedChange = { id: 'c2', kind: 'row_set', record: 0, row, key: 'stage', label: 'Stage', type: 'select', from: 'Proposal', to: 'Won' }
    const result = await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }, { apply: applied(), writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    return (result as { recordId: string }).recordId
  }

  it('a row: its batch back through undoChange as the person; marked once, the message rewritten; never set that way again', async () => {
    const db = fresh()
    const recordId = await changeWon(db)
    const undo = vi.fn(async () => ({ ok: true as const, value: { version: 9, change_id: 'chg-undo', inserted_row_ids: [], created_column_ids: {}, undone_change_id: 'chg-1', restored: ['“Stage” on “Acme renewal”'], kept: [] } }))
    const writeMessage = vi.fn(async (..._args: unknown[]) => true)
    const appendLog = vi.fn(async () => true)
    expect(await undoKeptChange(db as never, { ...SCOPE, recordId, nowMs: NOW_MS }, { undo, writeMessage, appendLog })).toEqual({ ok: true, status: 'reverted' })
    expect(undo).toHaveBeenCalledWith(db, WS, 't-pipe', 'chg-1', { userId: 'u', asUserId: 'u', source: 'person' })
    expect(db.rows('kept_change')[0].undone_at).toBeTruthy()
    expect(writeMessage).toHaveBeenCalledWith(db, { ...SCOPE, conversationId: 'home' }, expect.objectContaining({ record_id: recordId, undone: true, to: 'Won', field: 'Stage' }))
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ line: expect.stringContaining('Undid Acme renewal') }), db)
    expect(await undoKeptChange(db as never, { ...SCOPE, recordId }, { undo })).toEqual({ ok: true, status: 'already' })
    expect(undo).toHaveBeenCalledTimes(1)
    // Never set that way again, by any source.
    const prior = await readPriorChanges(db as never, SCOPE, [{ id: 'r-acme', tableId: 't-pipe' }], [], NOW_MS)
    const { changes } = planChanges([{ kind: 'row', row: await acmeRow(db) }], { dates: [], amounts: [], numbers: [] }, prior!)
    expect(changes.some((c) => c.kind === 'row_set' && c.to === 'Won')).toBe(false)
  })

  it('when the batch id never landed, Undo puts the value back by hand, never silently nothing', async () => {
    const db = fresh()
    const recordId = await changeWon(db)
    db.rows('kept_change')[0].data_change_id = null
    db.rows('data_row').find((r) => r.id === 'r-acme')!.custom_fields = { stage: 'Won' }
    const apply = applied('chg-back')
    const undo = vi.fn()
    expect(await undoKeptChange(db as never, { ...SCOPE, recordId }, { apply, undo, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })).toEqual({ ok: true, status: 'reverted' })
    expect(undo).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledWith(db, WS, 't-pipe', { baseVersion: 7, ops: [{ op: 'update_row', row_id: 'r-acme', values: { stage: 'Proposal' } }] }, { userId: 'u', asUserId: 'u', source: 'person' })
    // Changed again since: left as it is.
    const db2 = fresh()
    const second = await changeWon(db2)
    db2.rows('kept_change')[0].data_change_id = null
    db2.rows('data_row').find((r) => r.id === 'r-acme')!.custom_fields = { stage: 'Lost' }
    const apply2 = applied()
    expect(await undoKeptChange(db2 as never, { ...SCOPE, recordId: second }, { apply: apply2, writeMessage: vi.fn(async () => true) })).toEqual({ ok: true, status: 'changed' })
    expect(apply2).not.toHaveBeenCalled()
  })

  it('a failed write of the batch id is retried', async () => {
    const db = fresh()
    const row = await acmeRow(db)
    const won: PlannedChange = { id: 'c2', kind: 'row_set', record: 0, row, key: 'stage', label: 'Stage', type: 'select', from: 'Proposal', to: 'Won' }
    const real = db.from.bind(db)
    let failed = 0
    const flaky = { ...db, from: (table: string) => {
      const q = real(table) as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'kept_change' || failed > 0) return q
      return { ...q, update: () => ({ eq: async () => { failed += 1; return { data: null, error: { message: 'timeout' } } } }) }
    } }
    const result = await applyKeptChange(flaky as never, { ...SCOPE, conversationId: 'home', item: item(), change: won, evidence: 'We signed.' }, { apply: applied(), writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(result.status).toBe('changed')
    expect(failed).toBe(1)
    expect(db.rows('kept_change')[0].data_change_id).toBe('chg-1')
  })

  it('changed again since: left as it is', async () => {
    const db = fresh()
    const recordId = await changeWon(db)
    const undo = vi.fn(async () => ({ ok: false as const, reason: 'invalid' as const, error: 'Nothing to restore: everything it changed has changed again since.' }))
    const writeMessage = vi.fn(async (..._args: unknown[]) => true)
    expect(await undoKeptChange(db as never, { ...SCOPE, recordId }, { undo, writeMessage })).toEqual({ ok: true, status: 'changed' })
    expect(writeMessage.mock.calls[0][2] as object).toMatchObject({ undone: true, changed: true })
  })

  it('a to-do: back where it was while still in the done state', async () => {
    const db = fresh()
    const change: PlannedChange = { id: 'c1', kind: 'task_done', record: 0, task: task() }
    const done = await applyKeptChange(db as never, { ...SCOPE, conversationId: 'home', item: item(), change, evidence: 'Sent.' }, { emit: vi.fn(), writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    const emit = vi.fn()
    expect(await undoKeptChange(db as never, { ...SCOPE, recordId: (done as { recordId: string }).recordId }, { emit, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })).toEqual({ ok: true, status: 'reverted' })
    expect(db.rows('actions')[0].status_id).toBe('backlog')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ fromStatusId: 'done', toStatusId: 'backlog', actorUserId: 'u' }))
  })

  it('another person’s change is not found', async () => {
    const db = fresh()
    const recordId = await changeWon(db)
    expect(await undoKeptChange(db as never, { workspaceId: WS, userId: 'sam', recordId })).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('the message part', () => {
  it('is the kept part type', () => {
    expect(KEPT_PART_TYPE).toBe('data-kept-up-to-date')
  })
})
