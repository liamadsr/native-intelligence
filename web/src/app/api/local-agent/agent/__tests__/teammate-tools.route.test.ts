/**
 * The Mac body's teammate tools through C1's tool route, with the C4 seam
 * wired (agent-seams.ts re-exports WS-C's runMacTeammateTool): what the route
 * answers, and what lands in the session's own thread. The rest of the route
 * is routes.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  db: null as unknown,
  checkUsageLimits: vi.fn(async (): Promise<unknown> => undefined),
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move?: unknown) => s),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => m.db }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: m.checkUsageLimits, logUsage: vi.fn(async () => 'logged') }))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({
  ...(await orig<typeof import('@/lib/local-agent/ledger')>()),
  moveTurn: m.moveTurn,
  turnStatus: vi.fn(async () => 'running'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
}))

import { POST as postTool } from '../tool/route'
import { isMacNativeTool, macNativeToolEntries } from '@/lib/local-agent/agent-seams'
import { signModelToken } from '@/lib/local-agent/tokens'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const SID = '77777777-7777-4777-8777-777777777777'
let db: FakeDb

function seed() {
  db = seeded({
    local_agent_session: [{
      id: SID, user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, conversation_id: CONV,
      started_by: 'agent', idempotency_key: `local-agent:${CONV}:session:eve-1:turn:t1:call:c1`,
      mode: 'edit', status: 'running', local_model: false, request: 'fix the login redirect', created_at: '2026-10-21T20:00:00.000Z',
      current_turn: 1, current_tracked_job_id: 'job-1', tracked_job_id: 'job-1', last_signal: null, last_signal_text: null,
      stop_requested_at: null, expires_at: new Date(Date.now() + 3600_000).toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(), updated_at: new Date().toISOString(),
    }],
    member: [{ id: 'mem-1', workspace_id: WS, user_id: USER }],
  })
  m.db = db
}

function tool(body: Record<string, unknown>) {
  const token = signModelToken({ sid: SID, uid: USER, wid: WS }).token
  return postTool(new Request('http://localhost/api/local-agent/agent/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: 'eve-session-1', turnId: 'turn-1', callId: 'call-1', ...body }),
  }))
}

const env = { ...process.env }
beforeEach(() => {
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'mac-body-test-secret'
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  m.moveTurn.mockClear()
  seed()
})
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe('the C4 seam, wired', () => {
  it('names the two teammate tools, with their schemas', () => {
    expect(isMacNativeTool('message_teammate')).toBe(true)
    expect(isMacNativeTool('report_to_person')).toBe(true)
    expect(isMacNativeTool('start_local_agent')).toBe(false)
    expect(macNativeToolEntries().map((e) => e.name)).toEqual(['message_teammate', 'report_to_person'])
  })

  it('message_teammate through POST /api/local-agent/agent/tool: sent, the question in the thread, the turn parked on it', async () => {
    const res = await tool({ toolName: 'message_teammate', input: { text: 'Which repository holds the API?' } })
    expect(res.status).toBe(200)
    expect((await res.json()).output).toMatchObject({ status: 'sent' })
    expect(db.tables.local_agent_event).toEqual([expect.objectContaining({ session_id: SID, source: 'server', kind: 'ask', payload: expect.objectContaining({ question: 'Which repository holds the API?', via: 'message_teammate' }) })])
    expect(db.tables.local_agent_session[0]).toMatchObject({ last_signal: 'ask', last_signal_text: 'Which repository holds the API?' })
    expect(m.moveTurn.mock.calls.map((c) => c[2])).toEqual([{ type: 'ask', question: 'Which repository holds the API?', from: 'teammate' }])
    // The same call again (eve's retry): sent once.
    expect((await tool({ toolName: 'message_teammate', input: { text: 'Which repository holds the API?' } })).status).toBe(200)
    expect(db.tables.local_agent_event).toHaveLength(1)
  })

  it('report_to_person lands in its thread; a bad input or missing eve ids is the handler’s 400, as is', async () => {
    expect((await tool({ toolName: 'report_to_person', input: { text: 'Reading the tests.' } })).status).toBe(200)
    expect(db.tables.local_agent_event).toEqual([expect.objectContaining({ kind: 'report', payload: expect.objectContaining({ text: 'Reading the tests.', via: 'report_to_person' }) })])
    const bad = await tool({ toolName: 'report_to_person', input: {} })
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe('INPUT_INVALID')
    const noIds = await tool({ toolName: 'report_to_person', input: { text: 'x' }, callId: undefined })
    expect(noIds.status).toBe(400)
  })
})
