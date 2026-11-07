/**
 * Route tests for POST /api/internal/agent-run/event — the eve coding-agent's
 * log pump + cancel signal (Phase 3).
 *
 * Load-bearing invariants:
 *   1. AUTH: 401 without secret / token.
 *   2. TAIL DISCIPLINE: appended text is kept to the last 4000 chars (the same
 *      tail the legacy sandbox runner keeps).
 *   3. FIRST-EVENT START: a still-`queued` run flips to `running` + gets
 *      started_at on the first beat; a run already past queued is NOT re-stamped.
 *   4. CANCEL SIGNAL: the response's `canceling` reflects a `canceling` OR an
 *      already-`canceled` row — the model's stop signal — and a canceling row is
 *      NEVER resurrected to `running`.
 *   5. BENIGN RACES: a missing row responds 200 {ok:false}, never 500.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-agent-run-secret-event-0000'

// Mutable single-row store for agent_run. `.update()` merges into it so we can
// assert the persisted status/log_tail/started_at.
const agentRunRow: { current: Record<string, unknown> | null } = { current: null }
const updates: Array<Record<string, unknown>> = []
/** The `.eq()` filters chained onto each update, parallel to `updates`. */
const updateFilters: Array<Array<[string, unknown]>> = []

function makeClient() {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) c[m] = () => c
    c.maybeSingle = async () => ({ data: agentRunRow.current, error: null })
    c.update = (patch: Record<string, unknown>) => {
      updates.push(patch)
      const filters: Array<[string, unknown]> = []
      updateFilters.push(filters)
      if (agentRunRow.current) agentRunRow.current = { ...agentRunRow.current, ...patch }
      const q: Record<string, unknown> = {
        eq: (k: string, v: unknown) => {
          filters.push([k, v])
          return q
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      }
      return q
    }
    return c
  }
  // The work ledger's lookup on every beat (`findWork`: select → eq → order →
  // limit → maybeSingle). No row here: the beat's ledger side is a no-op.
  const ledger = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c
    c.maybeSingle = async () => ({ data: null, error: null })
    return c
  }
  return { from: (table: string) => (table === 'tracked_job' ? ledger() : chain()) }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeClient() }))

import { POST } from '@/app/api/internal/agent-run/event/route'
import {
  mintAgentRunToken,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
} from '@/lib/agent-run/agent-run-token'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }

function eventReq(opts: { secret?: string | null; token?: string | null; body?: unknown }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret != null) headers[AGENT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token != null) headers[AGENT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/agent-run/event', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  })
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  agentRunRow.current = null
  updates.length = 0
  updateFilters.length = 0
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
})

describe('POST /api/internal/agent-run/event — auth', () => {
  it('401 without the shared secret', async () => {
    const res = await POST(eventReq({ token: mintAgentRunToken(CLAIMS), body: { text: 'x' } }))
    expect(res.status).toBe(401)
  })
  it('401 with a garbage token', async () => {
    const res = await POST(eventReq({ secret: SECRET, token: 'nope', body: { text: 'x' } }))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/internal/agent-run/event — first-event start + tail', () => {
  it('flips a queued run to running + stamps started_at on the first beat', async () => {
    agentRunRow.current = { status: 'queued', log_tail: null }
    const res = await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { kind: 'log', text: 'hello' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, canceling: false })
    expect(agentRunRow.current!.status).toBe('running')
    expect(typeof agentRunRow.current!.started_at).toBe('string')
    expect(agentRunRow.current!.log_tail).toBe('hello')
    // The flip is a compare-and-set: a Stop landing after the read must win.
    expect(updateFilters[0]).toContainEqual(['status', 'queued'])
  })

  it('does NOT re-stamp started_at for a run already running', async () => {
    agentRunRow.current = { status: 'running', log_tail: 'prior', started_at: '2020-01-01T00:00:00.000Z' }
    await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { text: ' more' } }))
    // status stays running; started_at untouched; text appended.
    expect(agentRunRow.current!.status).toBe('running')
    expect(agentRunRow.current!.started_at).toBe('2020-01-01T00:00:00.000Z')
    expect(agentRunRow.current!.log_tail).toBe('prior more')
    // The persisted patch never carried started_at.
    expect(updates.every((u) => !('started_at' in u))).toBe(true)
  })

  it('keeps only the last 4000 chars of the log (tail discipline)', async () => {
    agentRunRow.current = { status: 'running', log_tail: 'A'.repeat(3999) }
    await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { text: 'B'.repeat(10) } }))
    const tail = agentRunRow.current!.log_tail as string
    expect(tail.length).toBe(4000)
    // The oldest chars fell off the front; the newest 'B's are at the end.
    expect(tail.endsWith('B'.repeat(10))).toBe(true)
    expect(tail.startsWith('A')).toBe(true)
  })
})

describe('POST /api/internal/agent-run/event — cancel signal', () => {
  it('reports canceling:true and never resurrects a canceling row to running', async () => {
    agentRunRow.current = { status: 'canceling', log_tail: 'x' }
    const res = await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { text: 'y' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.canceling).toBe(true)
    // status stays canceling — the beat only appended the log.
    expect(agentRunRow.current!.status).toBe('canceling')
    expect(updates.every((u) => u.status === undefined)).toBe(true)
  })

  it('keeps reporting canceling:true once agentRunCancel has settled the row canceled', async () => {
    // Stop → canceling → (seconds later) canceled. The model's post_progress
    // must still hear STOP after the settle, or it would carry on working.
    agentRunRow.current = { status: 'canceled', log_tail: 'x' }
    const res = await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { text: 'y' } }))
    expect(res.status).toBe(200)
    expect((await res.json()).canceling).toBe(true)
    expect(agentRunRow.current!.status).toBe('canceled')
    expect(updates.every((u) => u.status === undefined)).toBe(true)
  })

  it.each(['running', 'pr_open', 'completed', 'failed'])('a %s row is not a cancel signal', async (status) => {
    agentRunRow.current = { status, log_tail: 'x' }
    const res = await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { text: 'y' } }))
    expect((await res.json()).canceling).toBe(false)
  })
})

describe('POST /api/internal/agent-run/event — benign races', () => {
  it('200 {ok:false} when the row is missing (no 500)', async () => {
    agentRunRow.current = null
    const res = await POST(eventReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS), body: { text: 'z' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.canceling).toBe(false)
    // No write attempted against a vanished row.
    expect(updates.length).toBe(0)
  })

  it('400 on an invalid JSON body', async () => {
    const req = new Request('http://localhost/api/internal/agent-run/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_RUN_SECRET_HEADER]: SECRET, [AGENT_RUN_TOKEN_HEADER]: mintAgentRunToken(CLAIMS) },
      body: '{not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
