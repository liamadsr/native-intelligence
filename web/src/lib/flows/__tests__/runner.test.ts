/**
 * Tests for the flow runner. runFlow is a pure function that takes a flow
 * (actions[]) + entity data + a fetch impl and returns { status, action_results }.
 * No DB. We mock the credentials key so the encrypted-token branches work.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { runFlow } from '../runner'
import type {
  RunnerActionData,
  RunSkillExecutor,
  RunAgentExecutor,
  ArchiveCaptureExecutor,
} from '../runner'
import { legacySnapshotFromResults } from '../run-record'
import { encryptCredential } from '@/lib/crypto/credentials'
import type { FlowAction, TriggerContext } from '../types'

const TEST_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_KEY
})

const sampleAction: RunnerActionData = {
  kind: 'action',
  id: 'a-1',
  identifier: 'ENG-42',
  title: 'Fix it',
  status_id: 's-2',
  status_name: 'In Progress',
  status_category: 'started',
  priority: 2,
  assignees: [],
  assignee_ids: [],
  label_ids: ['lbl-bug'],
  labels: [{ id: 'lbl-bug', name: 'bug' }],
  project_id: 'proj-1',
  team_id: 'team-1',
  workspace_id: 'w-1',
}

const sampleTrigger: TriggerContext = {
  type: 'entity_status_change',
  entity_type: 'action',
  from_status_id: 's-1',
  to_status_id: 's-2',
  fired_at: '2026-05-26T10:00:00.000Z',
}

function makeFetch(responseInit: { status: number; body?: string } = { status: 200, body: 'ok' }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit })
    return new Response(responseInit.body ?? '', { status: responseInit.status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function httpAction(
  over: Partial<Omit<FlowAction, 'config'>> & { config?: Partial<FlowAction['config']> } = {},
): FlowAction {
  return {
    id: over.id ?? 'act-1',
    type: 'http_post',
    config: {
      method: 'POST',
      url: 'https://example.com/webhook',
      headers: {},
      body_template: '{"id": "{{action.id}}"}',
      ...(over.config ?? {}),
    },
    condition: over.condition ?? null,
    parent_id: over.parent_id ?? null,
    enabled: over.enabled ?? true,
    bearer_token_encrypted: over.bearer_token_encrypted ?? null,
  }
}

describe('runFlow — single action', () => {
  it('renders body template and POSTs to URL', async () => {
    const { fetchImpl, calls } = makeFetch()
    const { status, action_results } = await runFlow(
      { actions: [httpAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    expect(action_results).toHaveLength(1)
    expect(action_results[0].skipped).toBe(false)
    expect(action_results[0].condition_met).toBe(true)
    expect(action_results[0].response_status_code).toBe(200)
    expect(calls[0].url).toBe('https://example.com/webhook')
    expect(calls[0].init.body).toBe('{"id": "a-1"}')
  })

  it('adds Authorization header from the per-action bearer token', async () => {
    const { fetchImpl, calls } = makeFetch()
    await runFlow(
      { actions: [httpAction({ bearer_token_encrypted: encryptCredential('secret-123') })] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer secret-123')
  })

  it('returns failed status on non-2xx response', async () => {
    const { fetchImpl } = makeFetch({ status: 502, body: 'bad gateway' })
    const { status, action_results } = await runFlow(
      { actions: [httpAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('failed')
    expect(action_results[0].status).toBe('failed')
    expect(action_results[0].response_status_code).toBe(502)
    expect(action_results[0].error_message).toBe('HTTP 502')
  })

  it('returns failed status on fetch error', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const { status, action_results } = await runFlow(
      { actions: [httpAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: failingFetch },
    )
    expect(status).toBe('failed')
    expect(action_results[0].error_message).toContain('ECONNREFUSED')
  })
})

describe('runFlow — fan-out with conditions', () => {
  it('fires actions whose conditions match and skips the rest', async () => {
    const { fetchImpl, calls } = makeFetch()
    const actions: FlowAction[] = [
      httpAction({ id: 'bug', condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-bug'] }] } }),
      httpAction({ id: 'feature', condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-feature'] }] } }),
      httpAction({ id: 'always', condition: null }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    expect(action_results.map((r) => ({ id: r.action_id, skipped: r.skipped }))).toEqual([
      { id: 'bug', skipped: false }, // label is bug → fires
      { id: 'feature', skipped: true }, // label is not feature → skipped
      { id: 'always', skipped: false }, // no condition → fires
    ])
    // Only the two matching actions made HTTP calls.
    expect(calls).toHaveLength(2)
  })

  it('isolates per-action failures — a failing action does not stop the chain', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      // First call fails, second succeeds.
      return new Response('', { status: n === 1 ? 500 : 200 })
    }) as unknown as typeof fetch
    const { status, action_results } = await runFlow(
      { actions: [httpAction({ id: 'one' }), httpAction({ id: 'two' })] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    // Both executed; flow is 'failed' because one executed action failed.
    expect(action_results).toHaveLength(2)
    expect(action_results[0].status).toBe('failed')
    expect(action_results[1].status).toBe('success')
    expect(status).toBe('failed')
    expect(n).toBe(2)
  })

  it('a skipped-only fire is success and makes no HTTP calls', async () => {
    const { fetchImpl, calls } = makeFetch()
    const actions: FlowAction[] = [
      httpAction({ id: 'never', condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-nope'] }] } }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    expect(action_results[0].skipped).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('an empty actions list is success with no results', async () => {
    const { fetchImpl, calls } = makeFetch()
    const { status, action_results } = await runFlow(
      { actions: [] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    expect(action_results).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('records a failed result for an unsupported action type without calling fetch', async () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch
    const bad = httpAction({ id: 'bad' })
    bad.type = 'mystery' as unknown as 'http_post'
    const { status, action_results } = await runFlow(
      { actions: [bad] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchSpy },
    )
    expect(status).toBe('failed')
    expect(action_results[0].error_message).toContain('Unsupported')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('runFlow — disabled actions + tree', () => {
  it('skips a disabled action (records disabled + makes no HTTP call)', async () => {
    const { fetchImpl, calls } = makeFetch()
    const { status, action_results } = await runFlow(
      { actions: [httpAction({ id: 'off', enabled: false }), httpAction({ id: 'on' })] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    const off = action_results.find((r) => r.action_id === 'off')!
    expect(off.disabled).toBe(true)
    expect(off.skipped).toBe(true)
    // Only the enabled action fired.
    expect(calls).toHaveLength(1)
  })

  it('prunes the whole subtree under a disabled ancestor', async () => {
    const { fetchImpl, calls } = makeFetch()
    const actions: FlowAction[] = [
      httpAction({ id: 'root', enabled: false }),
      httpAction({ id: 'child', parent_id: 'root' }),
      httpAction({ id: 'grandchild', parent_id: 'child' }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    // Every node in the disabled branch is recorded as disabled+skipped.
    for (const id of ['root', 'child', 'grandchild']) {
      const r = action_results.find((x) => x.action_id === id)!
      expect(r.disabled, id).toBe(true)
      expect(r.skipped, id).toBe(true)
    }
    expect(calls).toHaveLength(0)
  })

  it('runs parents before children (tree order)', async () => {
    const order: string[] = []
    const fetchImpl = (async (url: unknown) => {
      order.push(String(url))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    // Declared child-first to prove ordering isn't just array order. Each
    // action hits a distinct URL so we can read execution order off the calls.
    const actions: FlowAction[] = [
      httpAction({ id: 'child', parent_id: 'root', config: { url: 'https://example.com/child' } }),
      httpAction({ id: 'root', config: { url: 'https://example.com/root' } }),
    ]
    await runFlow({ actions }, sampleAction, sampleTrigger, 'https://dial8.ai', { fetch: fetchImpl })
    expect(order).toEqual(['https://example.com/root', 'https://example.com/child'])
  })

  it('an enabled child of an enabled parent still fires even if the parent failed (no failure propagation)', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return new Response('', { status: n === 1 ? 500 : 200 })
    }) as unknown as typeof fetch
    const actions: FlowAction[] = [
      httpAction({ id: 'root' }),
      httpAction({ id: 'child', parent_id: 'root' }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(action_results.find((r) => r.action_id === 'root')!.status).toBe('failed')
    expect(action_results.find((r) => r.action_id === 'child')!.status).toBe('success')
    expect(status).toBe('failed') // worst-of executed
    expect(n).toBe(2)
  })
})

describe('runFlow — incomplete (draft) actions', () => {
  it('skips an enabled action with no URL (incomplete) and fires the rest', async () => {
    const { fetchImpl, calls } = makeFetch()
    const actions: FlowAction[] = [
      httpAction({ id: 'draft', config: { url: '' } }),
      httpAction({ id: 'ready' }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    const draft = action_results.find((r) => r.action_id === 'draft')!
    expect(draft.incomplete).toBe(true)
    expect(draft.skipped).toBe(true)
    expect(draft.disabled).toBe(false)
    // Only the complete action fired.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://example.com/webhook')
  })

  it('does NOT prune a complete child of an incomplete parent (children are independent)', async () => {
    const { fetchImpl, calls } = makeFetch()
    const actions: FlowAction[] = [
      httpAction({ id: 'parent', config: { url: '' } }), // incomplete
      httpAction({ id: 'child', parent_id: 'parent' }), // complete
    ]
    const { action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(action_results.find((r) => r.action_id === 'parent')!.incomplete).toBe(true)
    expect(action_results.find((r) => r.action_id === 'child')!.skipped).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('treats a private-host URL as incomplete and never fires it (runtime SSRF guard)', async () => {
    const { fetchImpl, calls } = makeFetch()
    const { status, action_results } = await runFlow(
      { actions: [httpAction({ id: 'evil', config: { url: 'http://10.0.0.5/scan' } })] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl },
    )
    expect(status).toBe('success')
    expect(action_results[0].incomplete).toBe(true)
    expect(action_results[0].skipped).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────
// run_skill dispatch (injected executor)
// ──────────────────────────────────────────────────────────────────

const SKILL_ID = '11111111-2222-3333-4444-555555555555'

function skillAction(
  over: Partial<Omit<FlowAction, 'config'>> & { config?: Record<string, unknown> } = {},
): FlowAction {
  return {
    id: over.id ?? 'skill-1',
    type: 'run_skill',
    config: {
      skill_id: SKILL_ID,
      mode: 'report',
      ...(over.config ?? {}),
    } as FlowAction['config'],
    condition: over.condition ?? null,
    parent_id: over.parent_id ?? null,
    enabled: over.enabled ?? true,
    bearer_token_encrypted: null,
  }
}

function makeMockExecutor(
  result: Partial<Awaited<ReturnType<RunSkillExecutor>>> = {},
) {
  const calls: Array<{ action: FlowAction; ctx: Parameters<RunSkillExecutor>[1] }> = []
  const executor: RunSkillExecutor = async (action, ctx) => {
    calls.push({ action, ctx })
    return {
      status: 'success',
      request_summary: {
        method: 'SKILL',
        url: `skill://${SKILL_ID}`,
        header_names: [],
        body_byte_length: 42,
      },
      response_status_code: 200,
      response_body_preview: '# Report',
      error_message: null,
      duration_ms: 5,
      output_document_id: 'doc-1',
      ...result,
    }
  }
  return { executor, calls }
}

describe('runFlow — run_skill dispatch', () => {
  it('dispatches to the injected executor and merges its result (incl. output_document_id)', async () => {
    const { executor, calls } = makeMockExecutor()
    const { fetchImpl } = makeFetch()
    const { status, action_results } = await runFlow(
      { actions: [skillAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl, executors: { run_skill: executor } },
    )
    expect(status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0].action.id).toBe('skill-1')
    expect(calls[0].ctx.entity).toBe(sampleAction)
    expect(calls[0].ctx.trigger).toBe(sampleTrigger)
    expect(calls[0].ctx.appBaseUrl).toBe('https://dial8.ai')
    const r = action_results[0]
    expect(r.skipped).toBe(false)
    expect(r.status).toBe('success')
    expect(r.request_summary?.method).toBe('SKILL')
    expect(r.response_status_code).toBe(200)
    expect(r.output_document_id).toBe('doc-1')
  })

  it('a failed executor result fails the flow (worst-of executed)', async () => {
    const { executor } = makeMockExecutor({
      status: 'failed',
      response_status_code: 500,
      response_body_preview: null,
      error_message: 'Skill not found',
      output_document_id: null,
    })
    const { status, action_results } = await runFlow(
      { actions: [skillAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_skill: executor } },
    )
    expect(status).toBe('failed')
    expect(action_results[0].status).toBe('failed')
    expect(action_results[0].error_message).toBe('Skill not found')
  })

  it('records a failed result when no executor is injected', async () => {
    const { status, action_results } = await runFlow(
      { actions: [skillAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
    )
    expect(status).toBe('failed')
    expect(action_results[0].skipped).toBe(false)
    expect(action_results[0].status).toBe('failed')
    expect(action_results[0].error_message).toBe('run_skill executor not available')
  })

  it('a disabled run_skill action prunes its subtree exactly like http_post', async () => {
    const { executor, calls } = makeMockExecutor()
    const { fetchImpl, calls: httpCalls } = makeFetch()
    const actions: FlowAction[] = [
      skillAction({ id: 'off-skill', enabled: false }),
      httpAction({ id: 'child-http', parent_id: 'off-skill' }),
      skillAction({ id: 'grandchild-skill', parent_id: 'child-http' }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl, executors: { run_skill: executor } },
    )
    expect(status).toBe('success')
    for (const id of ['off-skill', 'child-http', 'grandchild-skill']) {
      const r = action_results.find((x) => x.action_id === id)!
      expect(r.disabled, id).toBe(true)
      expect(r.skipped, id).toBe(true)
    }
    expect(calls).toHaveLength(0)
    expect(httpCalls).toHaveLength(0)
  })

  it('skips a draft run_skill (non-uuid skill_id) as incomplete without calling the executor', async () => {
    const { executor, calls } = makeMockExecutor()
    const { status, action_results } = await runFlow(
      { actions: [skillAction({ id: 'draft', config: { skill_id: '' } })] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_skill: executor } },
    )
    expect(status).toBe('success')
    expect(action_results[0].incomplete).toBe(true)
    expect(action_results[0].skipped).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('gates run_skill by its own condition like any other action', async () => {
    const { executor, calls } = makeMockExecutor()
    const { action_results } = await runFlow(
      {
        actions: [
          skillAction({
            id: 'gated',
            condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-nope'] }] },
          }),
        ],
      },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_skill: executor } },
    )
    expect(action_results[0].skipped).toBe(true)
    expect(action_results[0].condition_met).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('workspace-scoped fire: null entity + extras thread workspace/capture into templates and the executor', async () => {
    const { executor, calls } = makeMockExecutor()
    const { fetchImpl, calls: httpCalls } = makeFetch()
    const wsTrigger: TriggerContext = {
      type: 'capture_processed',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: '2026-07-01T10:00:00.000Z',
    }
    const capture = { id: 'cap-1', title: 'Weekly sync' }
    const actions: FlowAction[] = [
      httpAction({
        id: 'hook',
        config: {
          body_template:
            '{"ws": "{{workspace.id}}", "cap": "{{capture.title}}", "entity": "{{entity.id}}"}',
        },
      }),
      skillAction({ id: 'skill' }),
    ]
    const { status } = await runFlow({ actions }, null, wsTrigger, 'https://dial8.ai', {
      fetch: fetchImpl,
      executors: { run_skill: executor },
      extras: { workspaceId: 'w-9', capture },
    })
    expect(status).toBe('success')
    // http_post rendered the workspace + capture tokens; entity tokens are empty.
    expect(httpCalls[0].init.body).toBe('{"ws": "w-9", "cap": "Weekly sync", "entity": ""}')
    // The executor received the null entity and the capture garnish.
    expect(calls).toHaveLength(1)
    expect(calls[0].ctx.entity).toBeNull()
    expect(calls[0].ctx.capture).toEqual(capture)
  })

  it('workspace-scoped fire: entity-field conditions gate against empty sets (fail-closed)', async () => {
    const { executor, calls } = makeMockExecutor()
    const wsTrigger: TriggerContext = {
      type: 'schedule',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: '2026-07-01T10:00:00.000Z',
    }
    const { status, action_results } = await runFlow(
      {
        actions: [
          skillAction({
            id: 'gated',
            condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-bug'] }] },
          }),
          skillAction({ id: 'open' }),
        ],
      },
      null,
      wsTrigger,
      'https://dial8.ai',
      { executors: { run_skill: executor }, extras: { workspaceId: 'w-9' } },
    )
    expect(status).toBe('success')
    expect(action_results.find((r) => r.action_id === 'gated')!.skipped).toBe(true)
    expect(action_results.find((r) => r.action_id === 'open')!.skipped).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('mixed flow: http_post and run_skill both execute; legacy snapshot tolerates the SKILL result', async () => {
    const { executor } = makeMockExecutor()
    const { fetchImpl, calls: httpCalls } = makeFetch()
    const actions: FlowAction[] = [skillAction({ id: 'skill-first' }), httpAction({ id: 'http-second' })]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl, executors: { run_skill: executor } },
    )
    expect(status).toBe('success')
    expect(httpCalls).toHaveLength(1)

    // The run-list summary mirrors the FIRST executed action — here the SKILL
    // result — without any http_post-specific assumptions.
    const snapshot = legacySnapshotFromResults(action_results)
    expect(snapshot.request_summary?.method).toBe('SKILL')
    expect(snapshot.request_summary?.url).toBe(`skill://${SKILL_ID}`)
    expect(snapshot.response_status_code).toBe(200)
    expect(snapshot.response_body_preview).toBe('# Report')
    expect(snapshot.error_message).toBeNull()
    expect(snapshot.duration_ms).toBeGreaterThan(0)
  })
})

// ──────────────────────────────────────────────────────────────────
// run_agent dispatch (injected executor) — mirrors run_skill dispatch
// ──────────────────────────────────────────────────────────────────

const AGENT_ID = '99999999-8888-4777-8666-555555555555'

function agentAction(
  over: Partial<Omit<FlowAction, 'config'>> & { config?: Record<string, unknown> } = {},
): FlowAction {
  return {
    id: over.id ?? 'agent-1',
    type: 'run_agent',
    config: {
      agent_id: AGENT_ID,
      repo: 'owner/repo',
      instructions: '',
      ...(over.config ?? {}),
    } as FlowAction['config'],
    condition: over.condition ?? null,
    parent_id: over.parent_id ?? null,
    enabled: over.enabled ?? true,
    bearer_token_encrypted: null,
  }
}

function makeMockAgentExecutor(result: Partial<Awaited<ReturnType<RunAgentExecutor>>> = {}) {
  const calls: Array<{ action: FlowAction; ctx: Parameters<RunAgentExecutor>[1] }> = []
  const executor: RunAgentExecutor = async (action, ctx) => {
    calls.push({ action, ctx })
    return {
      status: 'success',
      request_summary: { method: 'AGENT', url: `agent://${AGENT_ID}`, header_names: [], body_byte_length: 10 },
      response_status_code: 202,
      response_body_preview: 'Queued agent run r-1 on owner/repo',
      error_message: null,
      duration_ms: 3,
      dispatched: true,
      agent_run_id: 'r-1',
      ...result,
    }
  }
  return { executor, calls }
}

describe('runFlow — run_agent dispatch', () => {
  it('dispatches to the injected executor and merges its result (dispatched + agent_run_id)', async () => {
    const { executor, calls } = makeMockAgentExecutor()
    const { status, action_results } = await runFlow(
      { actions: [agentAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_agent: executor } },
    )
    expect(status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0].action.id).toBe('agent-1')
    expect(calls[0].ctx.entity).toBe(sampleAction)
    const r = action_results[0]
    expect(r.skipped).toBe(false)
    expect(r.status).toBe('success')
    expect(r.dispatched).toBe(true)
    expect(r.agent_run_id).toBe('r-1')
    expect(r.response_status_code).toBe(202)
  })

  it('an inert (disarmed) result is a non-failing success with dispatched:false', async () => {
    const { executor } = makeMockAgentExecutor({
      response_body_preview: 'run_agent dispatch is not yet enabled',
      dispatched: false,
      agent_run_id: null,
    })
    const { status, action_results } = await runFlow(
      { actions: [agentAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_agent: executor } },
    )
    expect(status).toBe('success')
    expect(action_results[0].status).toBe('success')
    expect(action_results[0].dispatched).toBe(false)
    expect(action_results[0].agent_run_id).toBeNull()
  })

  it('a failed executor result fails the flow (worst-of executed)', async () => {
    const { executor } = makeMockAgentExecutor({
      status: 'failed',
      response_status_code: 500,
      response_body_preview: null,
      error_message: 'no GitHub access for run-as user',
      dispatched: false,
      agent_run_id: null,
    })
    const { status, action_results } = await runFlow(
      { actions: [agentAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_agent: executor } },
    )
    expect(status).toBe('failed')
    expect(action_results[0].status).toBe('failed')
    expect(action_results[0].error_message).toBe('no GitHub access for run-as user')
  })

  it('records a failed result when no run_agent executor is injected', async () => {
    const { status, action_results } = await runFlow(
      { actions: [agentAction()] },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
    )
    expect(status).toBe('failed')
    expect(action_results[0].skipped).toBe(false)
    expect(action_results[0].status).toBe('failed')
    expect(action_results[0].error_message).toBe('run_agent executor not available')
  })

  it('a disabled run_agent action prunes its subtree exactly like http_post', async () => {
    const { executor, calls } = makeMockAgentExecutor()
    const { fetchImpl, calls: httpCalls } = makeFetch()
    const actions: FlowAction[] = [
      agentAction({ id: 'off-agent', enabled: false }),
      httpAction({ id: 'child-http', parent_id: 'off-agent' }),
      agentAction({ id: 'grandchild-agent', parent_id: 'child-http' }),
    ]
    const { status, action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { fetch: fetchImpl, executors: { run_agent: executor } },
    )
    expect(status).toBe('success')
    for (const id of ['off-agent', 'child-http', 'grandchild-agent']) {
      const r = action_results.find((x) => x.action_id === id)!
      expect(r.disabled, id).toBe(true)
      expect(r.skipped, id).toBe(true)
    }
    expect(calls).toHaveLength(0)
    expect(httpCalls).toHaveLength(0)
  })

  it('skips a draft run_agent (no agent/repo, no override) as incomplete without calling the executor', async () => {
    const { executor, calls } = makeMockAgentExecutor()
    const actions: FlowAction[] = [
      agentAction({ id: 'draft', config: { agent_id: 'not-a-uuid', repo: '', instructions: '' } }),
    ]
    const { action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_agent: executor } },
    )
    expect(calls).toHaveLength(0)
    expect(action_results[0].incomplete).toBe(true)
    expect(action_results[0].skipped).toBe(true)
  })

  it('gates run_agent by its own condition like any other action', async () => {
    const { executor, calls } = makeMockAgentExecutor()
    const actions: FlowAction[] = [
      agentAction({
        id: 'gated',
        condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-missing'] }] },
      }),
    ]
    const { action_results } = await runFlow(
      { actions },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { run_agent: executor } },
    )
    expect(calls).toHaveLength(0)
    expect(action_results[0].condition_met).toBe(false)
    expect(action_results[0].skipped).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────
// archive_capture dispatch (injected executor) — mirrors run_skill dispatch
// ──────────────────────────────────────────────────────────────────

function archiveAction(
  over: Partial<Omit<FlowAction, 'config'>> & { config?: Record<string, unknown> } = {},
): FlowAction {
  return {
    id: over.id ?? 'archive-1',
    type: 'archive_capture',
    config: (over.config ?? {}) as FlowAction['config'],
    condition: over.condition ?? null,
    parent_id: over.parent_id ?? null,
    enabled: over.enabled ?? true,
    bearer_token_encrypted: null,
  }
}

function makeMockArchiveExecutor(
  result: Partial<Awaited<ReturnType<ArchiveCaptureExecutor>>> = {},
) {
  const calls: Array<{ action: FlowAction; ctx: Parameters<ArchiveCaptureExecutor>[1] }> = []
  const executor: ArchiveCaptureExecutor = async (action, ctx) => {
    calls.push({ action, ctx })
    return {
      status: 'success',
      request_summary: {
        method: 'ARCHIVE_CAPTURE',
        url: 'capture://cap-1',
        header_names: [],
        body_byte_length: 0,
      },
      response_status_code: 200,
      response_body_preview: 'archived capture cap-1',
      error_message: null,
      duration_ms: 2,
      archived_capture_id: 'cap-1',
      ...result,
    }
  }
  return { executor, calls }
}

describe('runFlow — archive_capture dispatch', () => {
  it('dispatches to the injected executor and merges its result (archived_capture_id)', async () => {
    const { executor, calls } = makeMockArchiveExecutor()
    const { status, action_results } = await runFlow(
      { actions: [archiveAction()] },
      null,
      { ...sampleTrigger, type: 'capture_processed', entity_type: null },
      'https://dial8.ai',
      { executors: { archive_capture: executor }, extras: { workspaceId: 'w-1', capture: { id: 'cap-1', title: 'Junk' } } },
    )
    expect(status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0].ctx.capture).toEqual({ id: 'cap-1', title: 'Junk' })
    const r = action_results[0]
    expect(r.skipped).toBe(false)
    expect(r.status).toBe('success')
    expect(r.request_summary?.method).toBe('ARCHIVE_CAPTURE')
    expect(r.archived_capture_id).toBe('cap-1')
  })

  it('records a failed result when no executor is injected', async () => {
    const { status, action_results } = await runFlow(
      { actions: [archiveAction()] },
      null,
      { ...sampleTrigger, type: 'capture_processed', entity_type: null },
      'https://dial8.ai',
      { extras: { workspaceId: 'w-1', capture: { id: 'cap-1', title: 'Junk' } } },
    )
    expect(status).toBe('failed')
    expect(action_results[0].skipped).toBe(false)
    expect(action_results[0].error_message).toBe('archive_capture executor not available')
  })

  it('a failed executor result fails the flow', async () => {
    const { executor } = makeMockArchiveExecutor({
      status: 'failed',
      response_status_code: 500,
      error_message: 'Archive failed: boom',
      archived_capture_id: null,
    })
    const { status, action_results } = await runFlow(
      { actions: [archiveAction()] },
      null,
      { ...sampleTrigger, type: 'capture_processed', entity_type: null },
      'https://dial8.ai',
      { executors: { archive_capture: executor }, extras: { workspaceId: 'w-1', capture: { id: 'cap-1', title: 'x' } } },
    )
    expect(status).toBe('failed')
    expect(action_results[0].error_message).toBe('Archive failed: boom')
  })

  it('is always runnable (never a draft) and gated only by its own condition', async () => {
    const { executor, calls } = makeMockArchiveExecutor()
    const { action_results } = await runFlow(
      {
        actions: [
          archiveAction({
            condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['lbl-missing'] }] },
          }),
        ],
      },
      sampleAction,
      sampleTrigger,
      'https://dial8.ai',
      { executors: { archive_capture: executor } },
    )
    // Condition references a label the entity doesn't have → gated out, not run.
    expect(calls).toHaveLength(0)
    expect(action_results[0].condition_met).toBe(false)
    expect(action_results[0].skipped).toBe(true)
  })
})
