/**
 * The owner's event loops (email_received, chat_message, document_created)
 * summarize the owner's own mail, DMs and documents, so each of their runs is
 * stamped private to the person it ran as (flow_run.private_to), whatever
 * client the tools run on (migration 640's policy, restated in code):
 * list_flow_runs leaves them out for anyone else (with a note), get_flow_run
 * refuses them, and every other run stays the workspace's. The stamp is the
 * run's: after the loop's trigger changes or it is handed to someone else,
 * its old runs stay hidden. list_flows and update_flow show another member's loop without
 * its channel or sender filter ("a channel", "new email"). Made-up people.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => memoryDb({}) }))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))

import { createFlowTools, describeTrigger } from '../flows'

const OWNER = 'user-ana'
const TEAMMATE = 'user-bo'
const WS = 'ws-1'
const CH_DM = '55555555-5555-4555-8555-555555555555'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const flows = [
  { id: 'f-mail', workspace_id: WS, team_id: null, name: 'Mail digest', description: null, enabled: true, trigger_type: 'email_received', trigger_config: { kind: 'email_received', from: 'billing@vendor.example' }, actions: [], created_by: OWNER, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
  { id: 'f-chat', workspace_id: WS, team_id: null, name: 'DM helper', description: null, enabled: true, trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: CH_DM, mentions_only: false }, actions: [], created_by: OWNER, created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' },
  { id: 'f-daily', workspace_id: WS, team_id: null, name: 'Daily brief', description: null, enabled: true, trigger_type: 'schedule', trigger_config: { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' }, actions: [], created_by: OWNER, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' },
]

function run(id: string, flowId: string) {
  const flow = flows.find((f) => f.id === flowId)!
  return {
    id,
    flow_id: flowId,
    // Stamped at insert: a fire of an event loop is its run-as owner's alone.
    private_to: flow.trigger_type === 'schedule' ? null : flow.created_by,
    status: 'success',
    action_results: [{ action_id: 'a1', response_body_preview: flow.trigger_type === 'schedule' ? 'The daily brief' : 'Summary of the private thread' }],
    fired_at: '2026-11-10T09:00:00Z',
    // The embed, and its filter key as memoryDb reads it.
    flow: { workspace_id: WS, name: flow.name, actions: [] },
    'flow.workspace_id': WS,
  }
}

function tools(userId: string, flowRows: Array<Record<string, unknown>> = flows) {
  const db = memoryDb({
    flow: flowRows.map((f) => ({ ...f })),
    flow_run: [run('r-mail', 'f-mail'), run('r-chat', 'f-chat'), run('r-daily', 'f-daily')],
    member: [
      { id: 'm-ana', workspace_id: WS, user_id: OWNER, display_name: 'Ana Fernhill', role: 'member' },
      { id: 'm-bo', workspace_id: WS, user_id: TEAMMATE, display_name: 'Bo Quill', role: 'member' },
    ],
  })
  return createFlowTools(userId, db, WS) as unknown as Record<string, { execute: (input: Record<string, unknown>, o: typeof EXEC) => Promise<Record<string, unknown>> }>
}

describe("list_flow_runs / get_flow_run: the owner's event loops", () => {
  it('another member sees only the workspace loop runs, with a note', async () => {
    const out = await tools(TEAMMATE).list_flow_runs.execute({}, EXEC)
    expect((out.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['r-daily'])
    expect(out.note).toMatch(/Only the person a run of this loop ran for/)
    expect(JSON.stringify(out)).not.toContain('private thread')
  })

  it('another member asking for one event loop gets none', async () => {
    const out = await tools(TEAMMATE).list_flow_runs.execute({ flow_id: 'f-mail' }, EXEC)
    expect(out.runs ?? []).toEqual([])
    expect(JSON.stringify(out)).not.toContain('private thread')
  })

  it('the owner sees every run, the embed trimmed to workspace and name', async () => {
    const out = await tools(OWNER).list_flow_runs.execute({}, EXEC)
    const runs = out.runs as Array<{ id: string; flow: Record<string, unknown> }>
    expect(runs.map((r) => r.id).sort()).toEqual(['r-chat', 'r-daily', 'r-mail'])
    expect(out.note).toBeUndefined()
    expect(Object.keys(runs[0].flow).sort()).toEqual(['name', 'workspace_id'])
  })

  it('get_flow_run refuses another member an event loop run, and reads them a workspace one', async () => {
    const t = tools(TEAMMATE)
    for (const id of ['r-mail', 'r-chat']) {
      const out = await t.get_flow_run.execute({ run_id: id }, EXEC)
      expect(out.success).toBe(false)
      expect(String(out.error)).toMatch(/Only the person a run of this loop ran for/)
      expect(JSON.stringify(out)).not.toContain('private thread')
    }
    expect((await t.get_flow_run.execute({ run_id: 'r-daily' }, EXEC)).success).toBe(true)
  })

  it('get_flow_run reads the owner their own event loop run', async () => {
    const out = await tools(OWNER).get_flow_run.execute({ run_id: 'r-mail' }, EXEC)
    expect(out.success).toBe(true)
    expect(JSON.stringify(out)).toContain('private thread')
    expect(out.run).not.toHaveProperty('private_to')
  })

  it("the trigger changed to a schedule: the old mail runs stay Ana's", async () => {
    const changed = flows.map((f) => (f.id === 'f-mail' ? { ...f, trigger_type: 'schedule', trigger_config: { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' } } : f))
    const t = tools(TEAMMATE, changed)
    expect((await t.get_flow_run.execute({ run_id: 'r-mail' }, EXEC)).success).toBe(false)
    expect(JSON.stringify(await t.list_flow_runs.execute({ flow_id: 'f-mail' }, EXEC))).not.toContain('private thread')
  })

  it("the loop handed to Bo: Ana's old runs stay hers, never the new owner's", async () => {
    const handed = flows.map((f) => ({ ...f, created_by: TEAMMATE }))
    const bo = tools(TEAMMATE, handed)
    for (const id of ['r-mail', 'r-chat']) expect((await bo.get_flow_run.execute({ run_id: id }, EXEC)).success).toBe(false)
    const listed = await bo.list_flow_runs.execute({}, EXEC)
    expect((listed.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['r-daily'])
    // Ana still reads her own, though the loop is no longer hers.
    expect((await tools(OWNER, handed).get_flow_run.execute({ run_id: 'r-mail' }, EXEC)).success).toBe(true)
  })
})

describe("list_flows: another member's event loop details", () => {
  it('hides the channel and the sender filter from anyone but the owner', async () => {
    const out = await tools(TEAMMATE).list_flows.execute({}, EXEC)
    const byId = new Map((out.flows as Array<Record<string, unknown>>).map((f) => [f.id, f]))
    const mail = byId.get('f-mail')!
    const chat = byId.get('f-chat')!
    expect(mail.trigger_config).toEqual({ kind: 'email_received', owner_only: true })
    expect(mail.trigger).toBe("When new email arrives in its owner's inbox")
    expect(chat.trigger_config).toEqual({ kind: 'chat_message', mentions_only: false, channel: 'a channel', owner_only: true })
    expect(chat.trigger).toBe('When someone posts in a channel')
    expect(JSON.stringify(out)).not.toContain(CH_DM)
    expect(JSON.stringify(out)).not.toContain('billing@vendor.example')
    // A workspace loop is unchanged.
    expect(byId.get('f-daily')!.trigger_config).toEqual(flows[2].trigger_config)
  })

  it('shows the owner everything', async () => {
    const out = await tools(OWNER).list_flows.execute({}, EXEC)
    const byId = new Map((out.flows as Array<Record<string, unknown>>).map((f) => [f.id, f]))
    expect(byId.get('f-mail')!.trigger_config).toEqual(flows[0].trigger_config)
    expect(byId.get('f-mail')!.trigger).toBe('When new mail arrives in your inbox from billing@vendor.example')
    expect(byId.get('f-chat')!.trigger).toContain(CH_DM)
  })
})

describe('describeTrigger for a non-owner', () => {
  it('says "a channel" and "new email", never the owner\'s own details', () => {
    expect(describeTrigger('chat_message', { kind: 'chat_message', channel_id: CH_DM, mentions_only: true }, false)).toBe('When someone @mentions its owner in a channel')
    expect(describeTrigger('chat_message', { kind: 'chat_message', channel_id: null, mentions_only: true }, false)).toBe('When someone @mentions its owner in any team chat channel')
    expect(describeTrigger('email_received', { kind: 'email_received', from: 'x@vendor.example' }, false)).toBe("When new email arrives in its owner's inbox")
    expect(describeTrigger('document_created', { kind: 'document_created' }, false)).toBe('When someone creates a document its owner can see')
  })
})
