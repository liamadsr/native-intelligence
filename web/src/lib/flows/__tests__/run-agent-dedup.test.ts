/**
 * run_agent dispatch idempotency (bug #2).
 *
 * When ARMED (RUN_AGENT_DISPATCH_ENABLED=true), the flow-dispatch step runs
 * under retries:1, so a retry re-enters the executor. Without a guard it would
 * insert a SECOND agent_run row + emit a SECOND `agent/run.requested` (a
 * distinct agent_run_id, so agentRunExecute's own per-row guard can't dedup it →
 * doubled sandbox).
 *
 * With a fireId, dedup is exactly-once via agent_run.fire_key (migration 196,
 * UNIQUE): the insert carries `${fireId}:${action.id}` and a retry's duplicate
 * hits 23505 → the executor reuses the existing run WITHOUT emitting. Without a
 * fireId (test-fire), the approximate non-terminal (flow, action) pre-check
 * still applies.
 *
 * Env is set BEFORE import so the flag constant binds ON — a separate module
 * graph from run-agent.test.ts (which asserts the disarmed default).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.RUN_AGENT_DISPATCH_ENABLED = 'true'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => {}),
  insert: vi.fn(),
  insertPayloads: [] as Record<string, unknown>[],
  /** When set, agent_run inserts fail with this error (e.g. 23505). */
  insertError: null as { code: string; message: string } | null,
  /** Returned by the approximate pre-check AND the fire_key 23505 re-fetch. */
  existingRun: null as { id: string } | null,
  /** maybeSingle answers for other tables (the environment lookup: workspace, environment). */
  rows: {} as Record<string, unknown>,
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

/**
 * Chainable Supabase mock. agent_run maybeSingle terminals (both the
 * approximate pre-check and the fire_key re-fetch) return hoisted.existingRun;
 * inserts are spied, capture their payload, and fail with hoisted.insertError
 * when set.
 */
function makeServiceClient() {
  const builder = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const passthrough = () => chain
    for (const m of ['select', 'eq', 'order', 'limit', 'or', 'not', 'is']) {
      chain[m] = vi.fn(passthrough)
    }
    chain.insert = vi.fn((payload: Record<string, unknown>) => {
      hoisted.insert(table)
      if (table === 'agent_run') hoisted.insertPayloads.push(payload)
      return {
        select: () => ({
          single: async () =>
            table === 'agent_run' && hoisted.insertError
              ? { data: null, error: hoisted.insertError }
              : { data: { id: 'freshly-inserted' }, error: null },
        }),
      }
    })
    chain.maybeSingle = async () => {
      if (table === 'user_oauth_tokens') return { data: { access_token: 'ghp_test' }, error: null }
      if (table === 'member') return { data: { user_id: 'owner-user' }, error: null }
      if (table === 'agent_run') return { data: hoisted.existingRun, error: null }
      if (table in hoisted.rows) return { data: hoisted.rows[table], error: null }
      return { data: null, error: null }
    }
    chain.single = async () => ({ data: null, error: null })
    return chain
  }
  return { from: (table: string) => builder(table) }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeServiceClient() }))

const { createRunAgentExecutor, RUN_AGENT_DISPATCH_ENABLED } = await import('../run-agent')
import type { FlowAction, TriggerContext } from '../types'

const trigger: TriggerContext = {
  type: 'schedule',
  entity_type: null,
  from_status_id: null,
  to_status_id: null,
  fired_at: '2026-07-02T10:00:00.000Z',
}

function agentAction(config: Record<string, unknown>): FlowAction {
  return {
    id: 'agent-1',
    type: 'run_agent',
    config: config as unknown as FlowAction['config'],
    condition: null,
    parent_id: null,
    enabled: true,
    bearer_token_encrypted: null,
  }
}

const AGENT = '11111111-2222-4333-8444-555555555555'

function makeExecutor(fireId: string | null) {
  return createRunAgentExecutor({
    workspaceId: 'w-1',
    flowId: 'flow-1',
    runAsUserId: 'user-1',
    fireId,
  })
}

async function run(executor: ReturnType<typeof createRunAgentExecutor>) {
  return executor(
    agentAction({ agent_id: AGENT, repo: 'owner/repo', instructions: 'do it' }),
    { entity: null, trigger, appBaseUrl: 'https://dial8.ai', capture: null },
  )
}

beforeEach(() => {
  hoisted.send.mockClear()
  hoisted.insert.mockClear()
  hoisted.insertPayloads = []
  hoisted.insertError = null
  hoisted.existingRun = null
  hoisted.rows = {}
})

describe('createRunAgentExecutor — armed dispatch idempotency', () => {
  it('the flag is ON for this module graph', () => {
    expect(RUN_AGENT_DISPATCH_ENABLED).toBe(true)
  })

  it('inserts with fire_key `${fireId}:${action.id}` and emits once on first dispatch', async () => {
    const result = await run(makeExecutor('fire-abc'))
    expect(result.status).toBe('success')
    expect(result.dispatched).toBe(true)
    expect(result.agent_run_id).toBe('freshly-inserted')
    expect(hoisted.insertPayloads[0]?.fire_key).toBe('fire-abc:agent-1')
    // A loop's run is the loop's, never a person's (P10): its PR is a draft.
    expect(hoisted.insertPayloads[0]?.origin).toBe('loop')
    expect(hoisted.send).toHaveBeenCalledTimes(1)
  })

  it('a flow with no project runs in the workspace default cloud environment, and records it (migration 420)', async () => {
    hoisted.rows = {
      workspace: { default_cloud_environment_id: 'env-default' },
      environment: { id: 'env-default', kind: 'cloud', name: 'Default cloud', workspace_id: 'w-1', shared: true, created_by: null, network_access: 'trusted', env_vars: null, setup_script: null, archived_at: null },
    }
    await run(makeExecutor('fire-env'))
    expect(hoisted.insertPayloads[0]?.environment_id).toBe('env-default')
  })

  it('no workspace default: the run records none (the sandbox defaults, as before)', async () => {
    await run(makeExecutor('fire-none'))
    expect(hoisted.insertPayloads[0]).toHaveProperty('environment_id', null)
  })

  it('reuses the existing run and does NOT emit when the retry insert hits 23505', async () => {
    hoisted.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "agent_run_fire_key_uidx"' }
    hoisted.existingRun = { id: 'existing-run' }
    const result = await run(makeExecutor('fire-abc'))
    expect(result.status).toBe('success')
    expect(result.dispatched).toBe(true)
    expect(result.agent_run_id).toBe('existing-run')
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('fails (not success) on a non-23505 insert error', async () => {
    hoisted.insertError = { code: '23502', message: 'null value in column' }
    const result = await run(makeExecutor('fire-abc'))
    expect(result.status).toBe('failed')
    expect(result.dispatched).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('without a fireId, the approximate pre-check reuses a non-terminal run without inserting or emitting', async () => {
    hoisted.existingRun = { id: 'existing-run' }
    const result = await run(makeExecutor(null))
    expect(result.status).toBe('success')
    expect(result.dispatched).toBe(true)
    expect(result.agent_run_id).toBe('existing-run')
    expect(hoisted.insert).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('without a fireId and no prior run, inserts with a NULL fire_key and emits once', async () => {
    const result = await run(makeExecutor(null))
    expect(result.status).toBe('success')
    expect(result.agent_run_id).toBe('freshly-inserted')
    expect(hoisted.insertPayloads[0]?.fire_key).toBeNull()
    expect(hoisted.send).toHaveBeenCalledTimes(1)
  })
})
