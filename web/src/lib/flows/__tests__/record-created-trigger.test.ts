/**
 * The record_created trigger (forms phase 2): its config, who may emit and
 * when, what never fires, who a fire is for, and what a viewer who is not
 * the owner is shown.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitRecordsCreated, RECORD_CREATED_MAX_PER_BATCH, RECORD_CREATED_PERSON_DELAY_MS } from '../emit-record-created'
import { eventTriggerTargetProblem, ownerCanReadTable, recordFlowsToFire, recordSkipReason, recordTriggerTableProblem, type RecordFacts } from '../event-triggers'
import { validateRecordCreatedConfig, validateTriggerConfig } from '../queries'
import { TEMPLATE_TOKENS } from '../template'
import { entitylessTestTrigger } from '../test-fire'
import { flowRunPrivateTo, isOwnerEventTrigger, triggerConfigForViewer, type FlowWithSecrets } from '../types'

const WS = 'ws-1'
const TABLE = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'

describe('the config', () => {
  it('names one table by id, and nothing else is kept', () => {
    expect(validateRecordCreatedConfig({ table_id: TABLE.toUpperCase(), anything: 'else' })).toEqual({ kind: 'record_created', table_id: TABLE })
    expect(validateTriggerConfig('record_created', { table_id: TABLE })).toEqual({ kind: 'record_created', table_id: TABLE })
  })

  it.each([undefined, null, {}, { table_id: 'Leads' }, { table_id: 7 }, []])('refuses %j', (raw) => {
    expect(validateRecordCreatedConfig(raw)).toBeInstanceOf(Error)
  })
})

describe('the emitter', () => {
  it("a form's row fires at once, a person's about five minutes later, once per row", async () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    const send = vi.fn(async (_events: Array<{ id: string; ts?: number }>) => {})
    // The table's id goes out as the database spells it, whatever the caller's capitals.
    expect(await emitRecordsCreated({ workspaceId: WS, tableId: TABLE.toUpperCase(), rowIds: ['r1'], source: 'form', now }, { send })).toBe(1)
    expect(send).toHaveBeenCalledWith([{ name: 'flow/record.created', id: 'record-created:r1', data: { workspace_id: WS, table_id: TABLE, row_id: 'r1', source: 'form', created_at: '2026-11-15T12:00:00.000Z' } }])
    send.mockClear()
    await emitRecordsCreated({ workspaceId: WS, tableId: TABLE, rowIds: ['r2', 'r2', 'r3'], source: 'person', now }, { send })
    // One send for the whole batch.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].map((e) => [e.id, e.ts])).toEqual([
      ['record-created:r2', now + RECORD_CREATED_PERSON_DELAY_MS],
      ['record-created:r3', now + RECORD_CREATED_PERSON_DELAY_MS],
    ])
  })

  it('a paste of a thousand rows starts no thousand runs, and a failed send never throws', async () => {
    const send = vi.fn(async (_events: unknown[]) => {})
    const ids = Array.from({ length: 1000 }, (_, i) => `r${i}`)
    expect(await emitRecordsCreated({ workspaceId: WS, tableId: TABLE, rowIds: ids, source: 'person' }, { send })).toBe(RECORD_CREATED_MAX_PER_BATCH)
    expect(send.mock.calls[0][0]).toHaveLength(RECORD_CREATED_MAX_PER_BATCH)
    expect(await emitRecordsCreated({ workspaceId: WS, tableId: TABLE, rowIds: [], source: 'person' }, { send })).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
    const failing = vi.fn(async () => { throw new Error('inngest down') })
    expect(await emitRecordsCreated({ workspaceId: WS, tableId: TABLE, rowIds: ['r1'], source: 'form' }, { send: failing })).toBe(0)
  })
})

describe('what never fires', () => {
  const row = (over: Partial<RecordFacts> = {}): RecordFacts => ({ id: 'r1', workspace_id: WS, table_id: TABLE, archived: false, blank: false, table_archived: false, ...over })
  it('a row gone, in another workspace or table, archived, or still blank', () => {
    expect(recordSkipReason(row(), WS, TABLE)).toBeNull()
    expect(recordSkipReason(null, WS, TABLE)).toBe('deleted')
    expect(recordSkipReason(row({ workspace_id: 'ws-2' }), WS, TABLE)).toBe('deleted')
    expect(recordSkipReason(row({ table_id: OTHER }), WS, TABLE)).toBe('in another table')
    expect(recordSkipReason(row({ archived: true }), WS, TABLE)).toBe('archived')
    expect(recordSkipReason(row({ table_archived: true }), WS, TABLE)).toBe('archived')
    expect(recordSkipReason(row({ blank: true }), WS, TABLE)).toBe('still empty')
  })
})

/** A client whose visible_data_table_ids answers per user, and whose data_table read finds `tables`. */
function client(readable: Record<string, string[]>, tables: Array<{ id: string; workspace_id: string; archived_at: string | null }> = []) {
  const rpc = vi.fn(async (_name: string, args: { p_ids: string[]; p_user_id: string; p_grants: boolean }) => ({ data: args.p_ids.filter((id) => (readable[args.p_user_id] ?? []).includes(id)), error: null }))
  const from = () => {
    const f: Record<string, unknown> = {}
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => ((f[col] = v), q),
      is: (col: string, v: unknown) => ((f[col] = v), q),
      maybeSingle: async () => ({ data: tables.find((t) => t.id === f.id && t.workspace_id === f.workspace_id && t.archived_at === null) ?? null, error: null }),
    }
    return q
  }
  return { supabase: { rpc, from } as unknown as SupabaseClient, rpc }
}

describe('who a fire is for', () => {
  const flow = (id: string, owner: string | null, tableId = TABLE) => ({ id, created_by: owner, trigger_config: { kind: 'record_created', table_id: tableId } }) as unknown as FlowWithSecrets

  it('only loops on that table whose owner reads it without a grant', async () => {
    const { supabase, rpc } = client({ 'u-ana': [TABLE], 'u-cy': [] })
    const fired = await recordFlowsToFire(supabase, [flow('a', 'u-ana'), flow('a2', 'u-ana'), flow('c', 'u-cy'), flow('x', null), flow('o', 'u-ana', OTHER)], { table_id: TABLE })
    expect(fired.map((f) => f.id)).toEqual(['a', 'a2'])
    // Asked once per owner, and never with grants: an unattended run reads none.
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls.every(([, a]) => a.p_grants === false)).toBe(true)
  })

  it('fails closed when the rule cannot be read', async () => {
    const failing = { rpc: async () => ({ data: null, error: { message: 'down' } }) } as unknown as SupabaseClient
    expect(await ownerCanReadTable(failing, 'u-ana', TABLE)).toBe(false)
    const throwing = { rpc: async () => { throw new Error('down') } } as unknown as SupabaseClient
    expect(await ownerCanReadTable(throwing, 'u-ana', TABLE)).toBe(false)
  })

  it("is saved only on a live table of this workspace that the loop's owner reads", async () => {
    const tables = [
      { id: TABLE, workspace_id: WS, archived_at: null },
      { id: OTHER, workspace_id: 'ws-2', archived_at: null },
    ]
    const { supabase } = client({ 'u-ana': [TABLE, OTHER], 'u-cy': [] }, tables)
    const ask = (ownerUserId: string, tableId: unknown) => recordTriggerTableProblem(supabase, { workspaceId: WS, ownerUserId, triggerType: 'record_created', config: { table_id: tableId } })
    expect(await ask('u-ana', TABLE)).toBeNull()
    expect(await ask('u-cy', TABLE)).toContain('not a table')
    expect(await ask('u-ana', OTHER)).toContain('not a table')
    expect(await ask('u-ana', undefined)).toContain('not a table')
    // Another trigger has no table to check; the one entry point covers both targets.
    expect(await recordTriggerTableProblem(supabase, { workspaceId: WS, ownerUserId: 'u-cy', triggerType: 'schedule', config: {} })).toBeNull()
    expect(await eventTriggerTargetProblem(supabase, { workspaceId: WS, ownerUserId: 'u-cy', triggerType: 'record_created', config: { table_id: TABLE } })).toContain('not a table')
  })
})

describe("an owner's own event", () => {
  it('its runs are private to the owner, and its table is theirs to know', () => {
    expect(isOwnerEventTrigger('record_created')).toBe(true)
    expect(flowRunPrivateTo('record_created', 'u-ana')).toBe('u-ana')
    expect(triggerConfigForViewer('record_created', { kind: 'record_created', table_id: TABLE }, true)).toEqual({ kind: 'record_created', table_id: TABLE })
    const shown = triggerConfigForViewer('record_created', { kind: 'record_created', table_id: TABLE }, false)
    expect(shown).toEqual({ kind: 'record_created', table: 'a table', owner_only: true })
    expect(JSON.stringify(shown)).not.toContain(TABLE)
  })

  it('a step gets ids only, and a test fire names a row that is not there', () => {
    expect(TEMPLATE_TOKENS).toContain('{{trigger.row_id}}')
    expect(TEMPLATE_TOKENS).toContain('{{trigger.table_id}}')
    const t = entitylessTestTrigger('record_created', { table_id: TABLE }, '2026-11-15T12:00:00Z')
    expect(t).toMatchObject({ type: 'record_created', table_id: TABLE })
    expect(t.row_id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
