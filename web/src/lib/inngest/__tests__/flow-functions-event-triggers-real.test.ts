/**
 * The chat and document dispatchers with their REAL matchers, cap and
 * visibility checks together (queries.ts findMatchingFlowsFor…,
 * event-triggers.ts eventFireCapState / chatFlowsToFire / documentFlowsToFire),
 * against the usual in-memory Supabase double. Only the run itself (the
 * executors, the work ledger) is stubbed. In one fire: the loop whose owner
 * can read the item runs; the one whose owner can't is never touched; the one
 * at its daily cap is ledgered as a skip, once an hour; each row is stamped
 * private to the loop's owner (flow_run.private_to). After a loop is handed
 * to someone else, it fires for the NEW owner's mailbox and what they can
 * see, never the old owner's. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createStepMock } from '@/test/inngest-step-mock'
import { memoryDb } from '@/test/memory-db'

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  handlers: new Map<string, (arg: unknown) => Promise<unknown>>(),
  db: null as unknown,
  runFlow: vi.fn(async (..._args: unknown[]) => ({ status: 'success' as const, action_results: [] as unknown[] })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, handler: (arg: unknown) => Promise<unknown>) => {
      h.handlers.set(config.id, handler)
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/flows/runner', () => ({ runFlow: (...args: unknown[]) => h.runFlow(...args), RESPONSE_BODY_PREVIEW_BYTES: 2000 }))
vi.mock('@/lib/flows/run-skill', () => ({ createRunSkillExecutor: () => async () => ({}), flowRunDeadlineMs: (t: number) => t + 255_000 }))
vi.mock('@/lib/flows/run-agent', () => ({ createRunAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/archive-capture', () => ({ createArchiveCaptureExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/run-local-agent', () => ({ createRunLocalAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/call-tool', () => ({ createCallToolExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/flow-step-resume', () => ({ keepRunState: async () => {}, resumeParkedRun: async () => ({ ok: true }), FLOW_STEP_SETTLED_EVENT: 'flow/step.settled' }))
vi.mock('@/lib/work/recorder', () => ({ startWork: async () => ({ link: async () => {}, id: 'work-1' }), inertWork: () => ({ link: async () => {} }) }))
vi.mock('@/lib/work/flow-results', () => ({ settleFlowWork: async () => {} }))
vi.mock('@/lib/work/system-teammates', () => ({ flowAttribution: async () => ({ teammateId: null, area: null }) }))
vi.mock('@/lib/flows/run-as-member', () => ({ resolveRunAsMemberId: async () => 'm-ana' }))
vi.mock('@/lib/flows/reconcile-decision', () => ({ decideReconcileSkip: async () => null }))
vi.mock('@/lib/work/agent-paused', async (orig) => ({ ...(await orig<typeof import('@/lib/work/agent-paused')>()), checkAgentPaused: async () => false }))

await import('../flow-functions')
const { EVENT_CAP_SKIP_REASON, EVENT_FIRE_CAP_PER_DAY } = await import('@/lib/flows/event-triggers')

const WS = 'ws-fernhill'
const CH_DESIGN = '22222222-2222-4222-8222-222222222222'
const ACTION = { id: 'a-1', type: 'run_skill', enabled: true, config: {}, condition: null, parent_id: null }
const HOUR = 60 * 60 * 1000

function loop(id: string, owner: string, type: string, cfg: Row = {}): Row {
  return { id, workspace_id: WS, team_id: null, name: `Loop ${id}`, description: null, created_by: owner, enabled: true, trigger_type: type, trigger_config: { kind: type, ...cfg }, actions: [ACTION], created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' }
}

/** `n` real runs of a flow within the last day. */
function pastRuns(flowId: string, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${flowId}-run-${i}`, flow_id: flowId, status: 'success', response_body_preview: null, fired_at: new Date(Date.now() - (i + 2) * 60_000).toISOString() }))
}

let tables: Record<string, Row[]>
const run = (id: string, event: Record<string, unknown>) => h.handlers.get(id)!({ event, step: createStepMock() })
const newRows = () => tables.flow_run.filter((r) => !String(r.id).includes('-run-'))

beforeEach(() => {
  h.runFlow.mockClear()
  tables = {
    member: [
      { id: 'm-ana', user_id: 'u-ana', workspace_id: WS, role: 'member' },
      { id: 'm-ben', user_id: 'u-ben', workspace_id: WS, role: 'member' },
      { id: 'm-cy', user_id: 'u-cy', workspace_id: WS, role: 'member' },
    ],
    team_chat_channel: [{ id: CH_DESIGN, workspace_id: WS, team_id: 'team-design', kind: 'channel', name: 'design' }],
    team_member: [
      { team_id: 'team-design', member_id: 'm-ana' },
      { team_id: 'team-design', member_id: 'm-ben' },
    ],
    team_chat_member: [],
    team_chat_message: [
      { id: 'msg-1', channel_id: CH_DESIGN, workspace_id: WS, author_kind: 'member', author_member_id: 'm-ben', thread_root_id: null, mentions: [], kind: 'message', deleted_at: null },
    ],
    document: [{ id: 'doc-1', workspace_id: WS, status: 'active', visibility: 'workspace' }],
    flow: [],
    flow_run: [],
    attention_item: [],
  }
  const db = memoryDb(tables)
  // The graph's visibility rule (entity_refs_hidden): Cy can't see doc-1.
  ;(db as unknown as Record<string, unknown>).rpc = async (_fn: string, args: Record<string, unknown>) => ({
    data: args.p_user === 'u-cy' ? [{ entity_type: 'document', entity_id: 'doc-1' }] : [],
    error: null,
  })
  h.db = db as SupabaseClient
})

describe('chat_message: real matcher, visibility and cap in one fire', () => {
  const event = { id: 'chat-message:msg-1', data: { workspace_id: WS, message_id: 'msg-1', channel_id: CH_DESIGN, fired_at: '2026-11-16T15:00:00Z' } }

  it('runs the reader, never touches the non-reader, and ledgers the capped loop as a skip', async () => {
    tables.flow.push(
      loop('f-ana', 'u-ana', 'chat_message', { channel_id: CH_DESIGN, mentions_only: false }),
      // Cy is not on the design team: can't read the channel.
      loop('f-cy', 'u-cy', 'chat_message', { channel_id: CH_DESIGN, mentions_only: false }),
      // Ben can read it, but already ran his day's worth.
      loop('f-ben', 'u-ben', 'chat_message', { channel_id: CH_DESIGN, mentions_only: false }),
    )
    tables.flow_run.push(...pastRuns('f-ben', EVENT_FIRE_CAP_PER_DAY))

    const out = await run('flow-dispatch-on-chat-message', event)
    expect(out).toMatchObject({ dispatched: 1, capped: 1 })
    expect(h.runFlow).toHaveBeenCalledTimes(1)
    const rows = newRows()
    expect(rows.map((r) => r.flow_id).sort()).toEqual(['f-ana', 'f-ben'])
    expect(rows.find((r) => r.flow_id === 'f-ben')).toMatchObject({ response_body_preview: EVENT_CAP_SKIP_REASON, private_to: 'u-ben' })
    expect(rows.find((r) => r.flow_id === 'f-ana')?.response_body_preview).not.toBe(EVENT_CAP_SKIP_REASON)
    expect(rows.find((r) => r.flow_id === 'f-ana')).toMatchObject({ private_to: 'u-ana' })
    expect(rows.some((r) => r.flow_id === 'f-cy')).toBe(false)
  })

  it('a capped loop with a skip row in the last hour is skipped quietly (no second row)', async () => {
    tables.flow.push(loop('f-ben', 'u-ben', 'chat_message', { channel_id: CH_DESIGN, mentions_only: false }))
    tables.flow_run.push(...pastRuns('f-ben', EVENT_FIRE_CAP_PER_DAY), {
      id: 'f-ben-run-skip',
      flow_id: 'f-ben',
      status: 'success',
      response_body_preview: EVENT_CAP_SKIP_REASON,
      fired_at: new Date(Date.now() - HOUR / 2).toISOString(),
    })
    expect(await run('flow-dispatch-on-chat-message', event)).toMatchObject({ dispatched: 0, capped: 1 })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(newRows()).toEqual([])
  })

  it('skip rows are not runs: a loop just under the cap with skips beside it still runs', async () => {
    tables.flow.push(loop('f-ana', 'u-ana', 'chat_message', { channel_id: CH_DESIGN, mentions_only: false }))
    tables.flow_run.push(...pastRuns('f-ana', EVENT_FIRE_CAP_PER_DAY - 1), {
      id: 'f-ana-run-skip',
      flow_id: 'f-ana',
      status: 'success',
      response_body_preview: EVENT_CAP_SKIP_REASON,
      fired_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    })
    expect(await run('flow-dispatch-on-chat-message', event)).toMatchObject({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledTimes(1)
  })
})

describe('document_created: real matcher, visibility and cap in one fire', () => {
  const event = { id: 'document-created:doc-1', data: { workspace_id: WS, document_id: 'doc-1' } }

  it('runs the owner who can see it, skips the one who cannot, ledgers the capped one', async () => {
    tables.flow.push(loop('f-ana', 'u-ana', 'document_created'), loop('f-cy', 'u-cy', 'document_created'), loop('f-ben', 'u-ben', 'document_created'))
    tables.flow_run.push(...pastRuns('f-ben', EVENT_FIRE_CAP_PER_DAY))
    const out = await run('flow-dispatch-on-document-created', event)
    expect(out).toMatchObject({ dispatched: 1, capped: 1 })
    expect(h.runFlow).toHaveBeenCalledTimes(1)
    expect((h.runFlow.mock.calls[0][2] as Row).document_id).toBe('doc-1')
    const rows = newRows()
    expect(rows.map((r) => r.flow_id).sort()).toEqual(['f-ana', 'f-ben'])
    expect(rows.find((r) => r.flow_id === 'f-ben')).toMatchObject({ response_body_preview: EVENT_CAP_SKIP_REASON })
  })

  it('a private document fires nobody, its author included', async () => {
    tables.document[0].visibility = 'private'
    tables.flow.push(loop('f-ana', 'u-ana', 'document_created'))
    expect(await run('flow-dispatch-on-document-created', event)).toEqual({ dispatched: 0 })
    expect(h.runFlow).not.toHaveBeenCalled()
  })
})

describe('after a loop is handed to someone else', () => {
  const hand = (id: string, to: string) => {
    const f = tables.flow.find((r) => r.id === id)!
    f.created_by = to
  }

  it("email: it fires on the NEW owner's new mail, stamped to them, and no longer on the old owner's", async () => {
    tables.flow.push(loop('f-mail', 'u-ana', 'email_received'))
    hand('f-mail', 'u-ben')
    const mail = (user: string) => ({
      id: `email-received:${user}:m-1`,
      data: { workspace_id: WS, user_id: user, account_id: 'acct-1', thread_id: 't-1', message_id: 'm-1', from_email: 'cy@acme.example', fired_at: '2026-11-16T15:00:00Z' },
    })
    expect(await run('flow-dispatch-on-email-received', mail('u-ana'))).toMatchObject({ dispatched: 0 })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(await run('flow-dispatch-on-email-received', mail('u-ben'))).toMatchObject({ dispatched: 1 })
    expect(newRows()).toEqual([expect.objectContaining({ flow_id: 'f-mail', private_to: 'u-ben' })])
  })

  it("chat: what the NEW owner can read decides (Cy can't read the design channel; Ben can)", async () => {
    const event = { id: 'chat-message:msg-1', data: { workspace_id: WS, message_id: 'msg-1', channel_id: CH_DESIGN, fired_at: '2026-11-16T15:00:00Z' } }
    tables.flow.push(loop('f-chat', 'u-ana', 'chat_message', { channel_id: CH_DESIGN, mentions_only: false }))
    hand('f-chat', 'u-cy')
    expect(await run('flow-dispatch-on-chat-message', event)).toMatchObject({ dispatched: 0 })
    hand('f-chat', 'u-ben')
    expect(await run('flow-dispatch-on-chat-message', event)).toMatchObject({ dispatched: 1 })
    expect(newRows()).toEqual([expect.objectContaining({ flow_id: 'f-chat', private_to: 'u-ben' })])
  })

  it("documents: what the NEW owner can see decides (Cy can't see doc-1)", async () => {
    const event = { id: 'document-created:doc-1', data: { workspace_id: WS, document_id: 'doc-1' } }
    tables.flow.push(loop('f-doc', 'u-ana', 'document_created'))
    hand('f-doc', 'u-cy')
    expect(await run('flow-dispatch-on-document-created', event)).toEqual({ dispatched: 0 })
    hand('f-doc', 'u-ben')
    expect(await run('flow-dispatch-on-document-created', event)).toMatchObject({ dispatched: 1 })
    expect(newRows()).toEqual([expect.objectContaining({ flow_id: 'f-doc', private_to: 'u-ben' })])
  })
})
