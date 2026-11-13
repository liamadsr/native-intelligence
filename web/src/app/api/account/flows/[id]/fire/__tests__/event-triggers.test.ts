/**
 * Run now on the owner's mail, chat and document loops: each fires with its
 * OWN trigger context (test-fire.ts entitylessTestTrigger, the same build as
 * chat's test_flow), never a status change against a synthetic action, and
 * the run is stamped private to the caller it ran as (flow_run.private_to).
 * A schedule loop's run is not stamped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runFlow: vi.fn(async () => ({ status: 'success', action_results: [] })),
  flow: null as Record<string, unknown> | null,
  inserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    user: { id: 'user-1' },
    workspaceId: 'ws-1',
    supabase: {
      from: () => {
        const c: Record<string, unknown> = {}
        c.select = () => c
        c.eq = () => c
        c.maybeSingle = async () => ({ data: h.flow, error: null })
        return c
      },
    },
  }),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'update']) c[m] = () => c
      c.maybeSingle = async () => ({ data: { settings: {} }, error: null })
      c.insert = async (row: Record<string, unknown>) => {
        if (table === 'flow_run') h.inserts.push(row)
        return { error: null }
      }
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return c
    },
  }),
}))
vi.mock('@/lib/flows/runner', () => ({ runFlow: h.runFlow }))
vi.mock('@/lib/flows/run-skill', () => ({ createRunSkillExecutor: () => async () => ({}), flowRunDeadlineMs: () => Date.now() + 1000 }))
vi.mock('@/lib/flows/run-agent', () => ({ createRunAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/archive-capture', () => ({ createArchiveCaptureExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/queries', () => ({ loadRunnerEntityData: async () => null }))

import { POST } from '../route'
import { SYNTH_ID } from '@/lib/flows/test-fire'

const CH = '55555555-5555-4555-8555-555555555555'
const fire = () => POST(new Request('http://localhost/api/account/flows/flow-1/fire', { method: 'POST', body: '{}' }) as never, { params: Promise.resolve({ id: 'flow-1' }) })
const flow = (trigger_type: string, trigger_config: Record<string, unknown>) => ({ id: 'flow-1', workspace_id: 'ws-1', name: 'Loop', trigger_type, trigger_config, actions: [], created_by: 'user-owner' })

beforeEach(() => {
  h.runFlow.mockClear()
  h.inserts = []
})

describe('Run now on the event loops', () => {
  for (const [type, cfg, ids] of [
    ['email_received', { kind: 'email_received', from: 'acme.example' }, { email_thread_id: SYNTH_ID, email_account_id: null }],
    ['chat_message', { kind: 'chat_message', channel_id: CH, mentions_only: false }, { chat_message_id: SYNTH_ID, chat_channel_id: CH, chat_thread_root_id: null }],
    ['document_created', { kind: 'document_created' }, { document_id: SYNTH_ID }],
  ] as const) {
    it(`${type}: its own trigger, no entity, and the run is the caller's alone`, async () => {
      h.flow = flow(type, cfg)
      const res = await fire()
      expect(res.status).toBe(200)
      const [, entity, trigger] = h.runFlow.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>]
      expect(entity).toBeNull()
      expect(trigger).toMatchObject({ type, entity_type: null, from_status_id: null, to_status_id: null, ...ids })
      expect(h.inserts[0]).toMatchObject({ flow_id: 'flow-1', triggered_by_action_id: null, private_to: 'user-1' })
    })
  }

  it("a quote loop fires as a quote, and a schedule loop's run is not stamped", async () => {
    h.flow = flow('quote_received', { kind: 'quote_received' })
    await fire()
    expect((h.runFlow.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({ type: 'quote_received', quote_id: SYNTH_ID })
    h.flow = flow('schedule', { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' })
    await fire()
    expect(h.inserts[1]).not.toHaveProperty('private_to')
  })
})
