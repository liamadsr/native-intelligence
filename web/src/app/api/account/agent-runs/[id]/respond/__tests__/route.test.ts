import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/account/agent-runs/[id]/respond — answer a work run parked in
 * needs_input. Locks: cross-workspace tenancy (member of the RUN's workspace +
 * equal to triggered_by), the three guards (kind/status/pending_input), the
 * CAS needs_input→queued + action mirror, the Inngest resume emit with the
 * structured response, and the compensation that reverts the CAS when the emit
 * throws.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

let currentUser: { id: string } | null = { id: 'starter-1' }
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () =>
    currentUser
      ? { supabase: makeSupabase(), user: currentUser }
      : new Response('no', { status: 401 }),
}))

const inngestSend = vi.fn(async (..._a: unknown[]) => ({ ids: ['evt'] }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => inngestSend(...a) },
}))

// The interaction-control WRITES (CAS/mirror/revert) go through the SERVICE client
// since Phase 3 (member UPDATE RLS is dropped). It shares the module-level fixtures
// with the cookie client, so `writes` still captures every write for assertions.
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => makeSupabase(),
}))

// ── Chainable Supabase stub ───────────────────────────────────────────────────
//
// The route touches: agent_run (load select, CAS update, revert update),
// member (membership select), actions (mirror update). We drive behaviour with
// module-level fixtures the tests mutate, and record every write for assertions.

interface RunRow {
  id: string
  kind: string
  status: string
  workspace_id: string
  triggered_by: string | null
  action_id: string | null
  pending_input: unknown
}

let runRow: RunRow | null
let memberRow: { id: string } | null
let casReturnsRows: boolean // does the needs_input→queued CAS match a row?
const writes: Array<{ table: string; patch: Record<string, unknown> }> = []

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'agent_run') {
        return {
          // load: .select(...).eq('id', id).maybeSingle()
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: runRow, error: null }),
            }),
          }),
          // CAS or revert: .update(patch).eq().eq().eq().select()  (CAS)
          //                .update(patch).eq().eq().eq()           (revert, awaited)
          update: (patch: Record<string, unknown>) => {
            writes.push({ table: 'agent_run', patch })
            const selectResult = {
              // CAS path ends in .select() → array of matched rows
              select: async () => ({ data: casReturnsRows ? [{ id: runRow?.id }] : [] }),
            }
            const chain = {
              eq: () => chain,
              select: selectResult.select,
              // revert path awaits the final .eq() thenable
              then: (onF?: (v: unknown) => unknown) => Promise.resolve({ data: null }).then(onF),
            }
            return chain
          },
        }
      }
      if (table === 'member') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: memberRow }),
              }),
            }),
          }),
        }
      }
      // actions mirror: .update(patch).eq().eq()  (awaited)
      return {
        update: (patch: Record<string, unknown>) => {
          writes.push({ table: 'actions', patch })
          const chain = {
            eq: () => chain,
            then: (onF?: (v: unknown) => unknown) => Promise.resolve({ data: null }).then(onF),
          }
          return chain
        },
      }
    },
  }
}

import { POST } from '../route'

function req(body: unknown) {
  return new Request('http://localhost/api/account/agent-runs/run-1/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'run-1' })

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  currentUser = { id: 'starter-1' }
  memberRow = { id: 'member-1' }
  casReturnsRows = true
  runRow = {
    id: 'run-1',
    kind: 'workspace',
    status: 'needs_input',
    workspace_id: 'ws-1',
    triggered_by: 'starter-1',
    action_id: 'action-1',
    pending_input: { requestId: 'req-1', approveOptionId: 'approve', denyOptionId: 'deny', questions: [], askedAt: 't' },
  }
})

describe('POST respond — happy path', () => {
  it('CASes needs_input→queued, mirrors the action, and emits work/run.resumed with answers', async () => {
    const res = await POST(req({ answers: [{ question: 'Which tone?', answer: 'Formal' }] }), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'queued' })

    // agent_run CAS to queued, with started_at re-stamped as THIS turn's start:
    // the stale-run reaper measures from started_at, and an answer that lands
    // hours after the park must not make the resumed turn look stale.
    const runWrite = writes.find((w) => w.table === 'agent_run')
    expect(runWrite?.patch).toEqual({ status: 'queued', started_at: expect.any(String) })
    const restamped = Date.parse(runWrite?.patch.started_at as string)
    expect(Math.abs(restamped - Date.now())).toBeLessThan(60_000)
    // action mirror to working.
    const actionWrite = writes.find((w) => w.table === 'actions')
    expect(actionWrite?.patch).toEqual({ agent_run_status: 'working' })

    // Inngest resume with the STRUCTURED response (the shape resumeWorkRun consumes).
    expect(inngestSend).toHaveBeenCalledTimes(1)
    const evt = inngestSend.mock.calls[0][0] as { name: string; data: Record<string, unknown> }
    expect(evt.name).toBe('work/run.resumed')
    expect(evt.data.agent_run_id).toBe('run-1')
    expect(evt.data.workspace_id).toBe('ws-1')
    expect(evt.data.response).toEqual({
      answers: [{ question: 'Which tone?', answer: 'Formal' }],
    })
    // The answered question's eve requestId rides the event so the resume driver can
    // reject a stale duplicate that would pair these answers with a newer question.
    expect(evt.data.request_id).toBe('req-1')
  })

  it('collapses the picker’s { selected, other } shape into a single canonical answer', async () => {
    const res = await POST(
      req({
        answers: [
          { question: 'Which recipients?', selected: ['Alice', 'Bob'], other: 'Carol' },
          { question: 'Which tone?', selected: [] },
        ],
      }),
      { params },
    )
    expect(res.status).toBe(200)
    const evt = inngestSend.mock.calls[0][0] as { data: { response: { answers: unknown } } }
    expect(evt.data.response).toEqual({
      answers: [
        { question: 'Which recipients?', answer: 'Alice, Bob, Carol' },
        { question: 'Which tone?', answer: '' },
      ],
    })
  })

  it('accepts { skipped: true } and emits a skipped response', async () => {
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(200)
    const evt = inngestSend.mock.calls[0][0] as { data: { response: unknown } }
    expect(evt.data.response).toEqual({ skipped: true })
  })
})

describe('POST respond — auth + guards', () => {
  it('401 when unauthenticated', async () => {
    currentUser = null
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(401)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('404 when the run does not exist', async () => {
    runRow = null
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(404)
  })

  it('403 when the caller is not a member of the run’s workspace (cross-workspace)', async () => {
    memberRow = null
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(403)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('403 when the caller is a member but not triggered_by', async () => {
    runRow!.triggered_by = 'someone-else'
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(403)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('400 when the run is a coding run (wrong kind)', async () => {
    runRow!.kind = 'coding'
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_KIND')
  })

  it('409 when the run is not in needs_input', async () => {
    runRow!.status = 'running'
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NOT_NEEDS_INPUT')
  })

  it('409 when pending_input is missing', async () => {
    runRow!.pending_input = null
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_PENDING_INPUT')
  })

  it('409 when the run is waiting on a teammate it handed work to, not on an answer (row 13)', async () => {
    runRow!.pending_input = {
      kind: 'delegation',
      askedAt: '2026-09-28T23:00:00.000Z',
      children: [{ requestId: 'req-d1', callId: 'call-d1', approveOptionId: 'approve', role: 'researcher', childRunId: 'child-1' }],
    }
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('WAITING_ON_TEAMMATE')
    expect(writes).toHaveLength(0)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('409 when the CAS loses the race (status flipped concurrently)', async () => {
    casReturnsRows = false
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NOT_NEEDS_INPUT')
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('400 on a malformed body (no answers, no skip)', async () => {
    const res = await POST(req({ foo: 'bar' }), { params })
    expect(res.status).toBe(400)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('400 when answers is present but empty', async () => {
    const res = await POST(req({ answers: [] }), { params })
    expect(res.status).toBe(400)
  })

  it('400 when answers exceeds the count cap (>8 entries)', async () => {
    const answers = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: 'a' }))
    const res = await POST(req({ answers }), { params })
    expect(res.status).toBe(400)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('400 when a single answer exceeds the char cap (>2000)', async () => {
    const res = await POST(
      req({ answers: [{ question: 'q', answer: 'x'.repeat(2001) }] }),
      { params },
    )
    expect(res.status).toBe(400)
    expect(inngestSend).not.toHaveBeenCalled()
  })
})

describe('POST respond — compensation', () => {
  it('reverts the CAS (queued→needs_input + action→needs_input) when the emit throws', async () => {
    inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const res = await POST(req({ skipped: true }), { params })
    expect(res.status).toBe(500)

    // Forward CAS then a REVERT: agent_run written twice (queued, then needs_input).
    const runWrites = writes.filter((w) => w.table === 'agent_run')
    expect(runWrites[0].patch).toEqual({ status: 'queued', started_at: expect.any(String) })
    expect(runWrites[runWrites.length - 1].patch).toEqual({ status: 'needs_input' })

    // action mirrored to working then reverted to needs_input.
    const actionWrites = writes.filter((w) => w.table === 'actions')
    expect(actionWrites[0].patch).toEqual({ agent_run_status: 'working' })
    expect(actionWrites[actionWrites.length - 1].patch).toEqual({ agent_run_status: 'needs_input' })
  })
})
