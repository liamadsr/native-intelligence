import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/account/agent-runs/[id] — the run-read the drill-in + detail page
 * poll. Loops v3 extends it with `can_chat` (terminal && session_state present)
 * and `pending_input`, and STRIPS `session_state` (the server-only eve
 * continuation token) from the response. These tests lock exactly that: the
 * derived flag, the surfaced pending_input, and the never-leaked session_state.
 */

let userRow: { id: string } | null = { id: 'u1' }
let workspaceId: string | null = 'ws-1'
let selectedData: Record<string, unknown> | null

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: userRow } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: selectedData, error: null }),
          }),
        }),
      }),
    }),
  }),
}))
vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: async () => workspaceId,
}))

import { GET } from '../route'

const params = Promise.resolve({ id: 'run-1' })
function req() {
  return new Request('http://localhost/api/account/agent-runs/run-1')
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    sandbox_id: 'eve:sess-1',
    kind: 'workspace',
    task_prompt: 'Draft the email',
    result_summary: 'Drafted it',
    deliverables: [],
    resources: [],
    attention_item_id: 'ai-1',
    pending_input: null,
    session_state: { sessionId: 'sess-secret', streamIndex: 12 },
    agent: null,
    agent_recipe: null,
    flow: null,
    action: null,
    ...overrides,
  }
}

beforeEach(() => {
  userRow = { id: 'u1' }
  workspaceId = 'ws-1'
  selectedData = baseRow()
})

describe('GET agent-runs/[id] — can_chat + session_state stripping', () => {
  it('never returns session_state, and sets can_chat when terminal + session_state present', async () => {
    const res = await GET(req(), { params })
    expect(res.status).toBe(200)
    const { run } = await res.json()
    expect(run.can_chat).toBe(true)
    // The eve continuation token must NEVER reach the browser.
    expect('session_state' in run).toBe(false)
    expect(JSON.stringify(run)).not.toContain('ct-secret')
  })

  it('can_chat is false for a live run even if session_state somehow present', async () => {
    selectedData = baseRow({ status: 'running' })
    const { run } = await (await GET(req(), { params })).json()
    expect(run.can_chat).toBe(false)
  })

  it('can_chat is false when session_state is null (no parked handle)', async () => {
    selectedData = baseRow({ session_state: null })
    const { run } = await (await GET(req(), { params })).json()
    expect(run.can_chat).toBe(false)
  })

  it('can_chat is true for a failed run with a session (interrogable)', async () => {
    selectedData = baseRow({ status: 'failed' })
    const { run } = await (await GET(req(), { params })).json()
    expect(run.can_chat).toBe(true)
  })

  it('surfaces pending_input for a needs_input run', async () => {
    const pending = { requestId: 'r1', approveOptionId: 'approve', denyOptionId: 'deny', questions: [{ question: 'Q?', header: 'H', options: [], multiSelect: false }], askedAt: 't' }
    selectedData = baseRow({ status: 'needs_input', session_state: null, pending_input: pending })
    const { run } = await (await GET(req(), { params })).json()
    expect(run.pending_input).toEqual(pending)
    expect(run.can_chat).toBe(false)
    expect('session_state' in run).toBe(false)
  })

  it('401 when unauthenticated', async () => {
    userRow = null
    const res = await GET(req(), { params })
    expect(res.status).toBe(401)
  })

  it('404 when the run is not found', async () => {
    selectedData = null
    const res = await GET(req(), { params })
    expect(res.status).toBe(404)
  })
})
