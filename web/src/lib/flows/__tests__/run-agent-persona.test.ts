/**
 * A persona's runs are attributed to its teammate (bots-v3 Phase 6). The one
 * place an agent_run is made with a persona and no teammate is a loop's
 * run_agent action (an agent picked by id, no assignee). Its ledger row is
 * written with the persona (`agent_recipe_id`), and the work ledger resolves
 * it to the persona's teammate (agent-run-mirror.test.ts).
 *
 * DORMANT until RUN_AGENT_DISPATCH_ENABLED is on: with the flag off (v1) no
 * agent_run is written at all, so nothing reaches the ledger. Delegation,
 * a work item's Start and a chat's delegate always name a teammate. Env is set
 * BEFORE import so the flag binds ON (as run-agent-dedup.test.ts does).
 */
import { describe, it, expect, vi } from 'vitest'

process.env.RUN_AGENT_DISPATCH_ENABLED = 'true'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => {}),
  mirror: vi.fn(async (..._args: unknown[]) => null),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ ensureWorkForAgentRun: hoisted.mirror }))

function makeServiceClient() {
  const builder = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'or', 'not', 'is']) chain[m] = vi.fn(() => chain)
    chain.insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }) }))
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

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeServiceClient() }))

const { createRunAgentExecutor } = await import('../run-agent')
import type { FlowAction, TriggerContext } from '../types'

const AGENT = '11111111-2222-4333-8444-555555555555'

const trigger: TriggerContext = {
  type: 'schedule',
  entity_type: null,
  from_status_id: null,
  to_status_id: null,
  fired_at: '2026-10-03T10:00:00.000Z',
}

describe('run_agent: a persona’s run carries the persona to the work ledger', () => {
  it('writes the ledger row with the persona and no teammate when the agent is picked by id', async () => {
    const executor = createRunAgentExecutor({ workspaceId: 'w-1', flowId: 'flow-1', runAsUserId: 'user-1', fireId: 'fire-1' })
    const action: FlowAction = {
      id: 'agent-1',
      type: 'run_agent',
      config: { agent_id: AGENT, repo: 'owner/repo', instructions: 'do it' } as unknown as FlowAction['config'],
      condition: null,
      parent_id: null,
      enabled: true,
      bearer_token_encrypted: null,
    }
    const result = await executor(action, { entity: null, trigger, appBaseUrl: 'https://dial8.ai', capture: null })
    expect(result.dispatched).toBe(true)
    expect(hoisted.mirror).toHaveBeenCalledTimes(1)
    expect(hoisted.mirror.mock.calls[0]?.[1]).toMatchObject({ id: 'run-1', ai_team_member_id: null, agent_recipe_id: AGENT })
  })
})
