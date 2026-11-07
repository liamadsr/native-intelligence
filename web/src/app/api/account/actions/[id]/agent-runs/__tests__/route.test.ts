import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/account/actions/[id]/agent-runs (Loops v3 interactive-work rework).
 *
 * The action-scoped runs route now feeds the CANONICAL run surface (the Cloud-run
 * view in the action detail panel), so it must return the workspace-run columns
 * (kind, task_prompt, result_summary, deliverables, resources, pending_input,
 * attention_item_id, finished_at) AND a server-derived `can_chat` — while NEVER
 * returning `session_state` (the eve send handle). These tests lock:
 *   1. the SELECT requests the workspace-run columns + session_state (for the
 *      can_chat derivation) but the RESPONSE strips session_state from every row;
 *   2. can_chat = terminal && session_state present, per run;
 *   3. the pin (workspace_id + action_id) and newest-first ordering.
 */

let currentUser: { id: string } | null = { id: 'u1' }

// The route resolves auth via requireWorkspace (perf phase 2 migration); the
// mock mirrors the real helper's contract: 401 Response with no user,
// otherwise the fake query client + the pinned workspace.
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => {
    if (!currentUser) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return {
      supabase: { from: (table: string) => makeChain(table) },
      user: currentUser,
      workspaceId: 'ws-1',
    }
  },
}))

// Captured query facts for assertions.
let selectArg = ''
const eqCalls: Array<[string, unknown]> = []
let orderArg: { col: string; opts: unknown } | null = null

// The rows the mocked query resolves with (raw DB shape incl. session_state).
let rows: Array<Record<string, unknown>> = []

function makeChain(_table: string) {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: (arg: string) => {
      selectArg = arg
      return chain
    },
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val])
      return chain
    },
    order: (col: string, opts: unknown) => {
      orderArg = { col, opts }
      return chain
    },
    limit: async () => ({ data: rows, error: null }),
  })
  return chain
}

import { GET } from '../route'

function call(id = 'action-1') {
  return GET(new Request('http://localhost'), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  currentUser = { id: 'u1' }
  selectArg = ''
  eqCalls.length = 0
  orderArg = null
  rows = []
})

describe('GET action agent-runs — column shape + can_chat + session_state safety', () => {
  it('selects the workspace-run columns (kind/task/result/deliverables/resources/pending_input/attention_item_id/finished_at) plus session_state', async () => {
    await call()
    for (const col of [
      'kind',
      'task_prompt',
      'result_summary',
      'deliverables',
      'resources',
      'pending_input',
      'attention_item_id',
      'finished_at',
      'session_state',
    ]) {
      expect(selectArg).toContain(col)
    }
  })

  it('NEVER returns session_state on any row (it is the eve send handle)', async () => {
    rows = [
      { id: 'r1', status: 'completed', kind: 'workspace', session_state: { sessionId: 'SECRET', streamIndex: 3 }, agent: null },
      { id: 'r2', status: 'running', kind: 'workspace', session_state: null, agent: null },
    ]
    const res = await call()
    const body = await res.json()
    expect(body.runs).toHaveLength(2)
    for (const run of body.runs) {
      expect(run).not.toHaveProperty('session_state')
    }
    // Belt-and-suspenders: the secret token never appears anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain('SECRET')
  })

  it('derives can_chat = terminal && session_state present, per run', async () => {
    rows = [
      // terminal + session parked → chattable
      { id: 'done-parked', status: 'completed', kind: 'workspace', session_state: { sessionId: 's', streamIndex: 1 }, agent: null },
      // terminal but no session → not chattable
      { id: 'done-nosession', status: 'failed', kind: 'workspace', session_state: null, agent: null },
      // live (needs_input) with a session → not chattable (not terminal)
      { id: 'live', status: 'needs_input', kind: 'workspace', session_state: { sessionId: 's', streamIndex: 1 }, agent: null },
      // pr_open is terminal for coding; with a session it would be chattable, but
      // coding runs never park one → null here → not chattable
      { id: 'coding', status: 'pr_open', kind: 'coding', session_state: null, agent: null },
    ]
    const res = await call()
    const body = await res.json()
    const byId = Object.fromEntries(body.runs.map((r: { id: string; can_chat: boolean }) => [r.id, r.can_chat]))
    expect(byId['done-parked']).toBe(true)
    expect(byId['done-nosession']).toBe(false)
    expect(byId['live']).toBe(false)
    expect(byId['coding']).toBe(false)
  })

  it('normalizes the embedded agent relation from a PostgREST array to a single object', async () => {
    rows = [
      { id: 'r1', status: 'queued', kind: 'workspace', session_state: null, agent: [{ id: 'a1', name: 'Eve', avatar_url: null }] },
    ]
    const res = await call()
    const body = await res.json()
    expect(body.runs[0].agent).toEqual({ id: 'a1', name: 'Eve', avatar_url: null })
  })

  it('pins the query to the caller workspace + action and orders newest-first', async () => {
    await call('action-42')
    expect(eqCalls).toContainEqual(['workspace_id', 'ws-1'])
    expect(eqCalls).toContainEqual(['action_id', 'action-42'])
    expect(orderArg).toEqual({ col: 'created_at', opts: { ascending: false } })
  })

  it('401s when unauthenticated', async () => {
    currentUser = null
    const res = await call()
    expect(res.status).toBe(401)
  })
})
