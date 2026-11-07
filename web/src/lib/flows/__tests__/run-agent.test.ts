/**
 * Tests for the run_agent executor (createRunAgentExecutor).
 *
 * THE load-bearing invariant: v1 ships INERT. With RUN_AGENT_DISPATCH_ENABLED
 * off (the default), the executor must reach the flag gate and return the inert
 * ActionResult — WITHOUT inserting an agent_run row and WITHOUT emitting
 * `agent/run.requested`. No sandbox can boot by accident.
 *
 * We mock the service client (a chainable query builder that hands back a
 * GitHub token so the precondition checks pass) and the Inngest client (a send
 * spy), then assert: inert result + no insert + no send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// send spy — asserted to be UNCALLED on the disarmed path.
const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => {}),
  insert: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.send },
}))

/**
 * A minimal chainable Supabase mock. Every query needed by the executor's
 * disarmed path resolves:
 *   - member (owner fallback) → { user_id }
 *   - user_oauth_tokens (github) → { access_token }
 * and agent_run.insert is spied so we can assert it's never called.
 */
function makeServiceClient() {
  const builder = (table: string): Record<string, unknown> => {
    const state: { table: string } = { table }
    const chain: Record<string, unknown> = {}
    const passthrough = () => chain
    for (const m of ['select', 'eq', 'order', 'limit', 'or']) {
      chain[m] = vi.fn(passthrough)
    }
    chain.insert = vi.fn(() => {
      hoisted.insert(state.table)
      return {
        select: () => ({ single: async () => ({ data: { id: 'should-not-happen' }, error: null }) }),
      }
    })
    chain.maybeSingle = async () => {
      if (table === 'user_oauth_tokens') return { data: { access_token: 'ghp_test' }, error: null }
      if (table === 'member') return { data: { user_id: 'owner-user' }, error: null }
      return { data: null, error: null }
    }
    chain.single = async () => ({ data: null, error: null })
    return chain
  }
  return { from: (table: string) => builder(table) }
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => makeServiceClient(),
}))

// Import AFTER the mocks so the module binds the mocked deps.
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

beforeEach(() => {
  hoisted.send.mockClear()
  hoisted.insert.mockClear()
})

describe('createRunAgentExecutor — disarmed (v1 inert)', () => {
  it('the flag defaults to OFF', () => {
    // If this ever flips to true by default, v1 is no longer inert.
    expect(RUN_AGENT_DISPATCH_ENABLED).toBe(false)
  })

  it('records the inert result and does NOT insert a row or emit an event', async () => {
    const executor = createRunAgentExecutor({
      workspaceId: 'w-1',
      flowId: 'flow-1',
      runAsUserId: 'user-1',
    })
    const result = await executor(agentAction({ agent_id: '11111111-2222-4333-8444-555555555555', repo: 'owner/repo', instructions: 'do it' }), {
      entity: null,
      trigger,
      appBaseUrl: 'https://dial8.ai',
      capture: null,
    })

    expect(result.status).toBe('success')
    expect(result.dispatched).toBe(false)
    expect(result.agent_run_id).toBeNull()
    expect(result.response_status_code).toBe(202)
    expect(result.response_body_preview).toBe('run_agent dispatch is not yet enabled')
    expect(result.error_message).toBeNull()

    // The two disarmed lines never ran.
    expect(hoisted.insert).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('short-circuits with a clean failure (no insert/emit) when there is no repo', async () => {
    const executor = createRunAgentExecutor({
      workspaceId: 'w-1',
      flowId: 'flow-1',
      runAsUserId: 'user-1',
    })
    const result = await executor(
      agentAction({ agent_id: '11111111-2222-4333-8444-555555555555', repo: '', instructions: '' }),
      { entity: null, trigger, appBaseUrl: 'https://dial8.ai', capture: null },
    )
    expect(result.status).toBe('failed')
    expect(result.dispatched).toBe(false)
    expect(result.error_message).toContain('no repo')
    expect(hoisted.insert).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('fails cleanly when the config has no resolvable agent (no insert/emit)', async () => {
    const executor = createRunAgentExecutor({
      workspaceId: 'w-1',
      flowId: 'flow-1',
      runAsUserId: 'user-1',
    })
    // Valid repo + github token, but no agent_id and no action-context override.
    const result = await executor(
      agentAction({ agent_id: '', repo: 'owner/repo', instructions: '' }),
      { entity: null, trigger, appBaseUrl: 'https://dial8.ai', capture: null },
    )
    expect(result.status).toBe('failed')
    expect(result.dispatched).toBe(false)
    expect(result.error_message).toContain('agent persona')
    expect(hoisted.insert).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})
