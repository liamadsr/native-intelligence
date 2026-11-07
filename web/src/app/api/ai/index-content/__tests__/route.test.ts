/**
 * Tests for POST /api/ai/index-content — the universal capture-finished seam.
 *
 * Invariants locked in:
 *  - The route sends claim/extract-from-source (row-resolved workspace,
 *    memberId, capture owner as userId) BEFORE indexing, so an indexing
 *    failure can't strand knowledge extraction. This route is the one server
 *    call every capture-stop path makes — cloud batch, live mode, web mic —
 *    which is why extraction is triggered here and not (only) on
 *    flow/capture.processed (live-mode captures never emit that).
 *  - Guards mirror capture-ingest.ts: no send for demo captures or bodies
 *    under MIN_SUMMARY_CHARS (auto-record blips).
 *  - A send failure never fails the request.
 *  - project_id falls back to the capture ROW's value when the payload omits
 *    it (the client-trusted payload was the source of the PROD-only 23502,
 *    migration 188).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  inngestSend: vi.fn(async (..._args: unknown[]) => ({ ids: ['evt-1'] })),
  indexCapture: vi.fn(async (..._args: unknown[]) => ({ chunksCreated: 2 })),
  getCurrentWorkspaceId: vi.fn(async () => 'ws-cookie'),
  emitCaptureProcessed: vi.fn((_args: unknown) => {}),
}))
vi.mock('@/lib/flows/emit-capture-processed', () => ({
  emitCaptureProcessed: hoisted.emitCaptureProcessed,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: hoisted.inngestSend,
    // The route imports MIN_SUMMARY_CHARS from capture-ingest.ts, whose module
    // load defines the Inngest function — stub it so the import doesn't throw.
    createFunction: vi.fn(() => ({})),
  },
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId }))
vi.mock('@/lib/ai/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/embeddings')>()
  return { ...actual, indexCapture: hoisted.indexCapture }
})

let captureRow: Record<string, unknown> | null = null
let memberRow: { id: string } | null = { id: 'member-1' }

const fakeSupabase = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {}
    const proxy: unknown = new Proxy(chain, {
      get(_, prop: string) {
        if (prop === 'maybeSingle') {
          if (table === 'captures') return async () => ({ data: captureRow, error: null })
          if (table === 'member') return async () => ({ data: memberRow, error: null })
          return async () => ({ data: null, error: null })
        }
        if (prop === 'then') {
          // proposed_change list query resolves empty
          return (cb: (v: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(cb)
        }
        return () => proxy
      },
    })
    return proxy
  },
}

const usage = vi.hoisted(() => ({ check: vi.fn(async (..._args: unknown[]) => undefined) }))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => ({ user: { id: 'user-1' }, supabase: fakeSupabase }),
  checkUsageLimits: usage.check,
}))

const { POST } = await import('@/app/api/ai/index-content/route')

const LONG_SUMMARY = 'A real meeting summary. '.repeat(20) // ~480 chars

function request(body: Record<string, unknown>) {
  return new Request('https://dial8.ai/api/ai/index-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  hoisted.inngestSend.mockClear()
  hoisted.indexCapture.mockClear()
  hoisted.indexCapture.mockResolvedValue({ chunksCreated: 2 })
  hoisted.inngestSend.mockResolvedValue({ ids: ['evt-1'] })
  hoisted.emitCaptureProcessed.mockClear()
  captureRow = {
    workspace_id: 'ws-row',
    project_id: 'proj-row',
    ai_summary: LONG_SUMMARY,
    content: null,
    metadata: null,
  }
  memberRow = { id: 'member-1' }
})

describe('POST /api/ai/index-content — extraction trigger', () => {
  it('sends claim/extract-from-source with row-resolved workspace and member', async () => {
    const res = await POST(request({ captureId: 'cap-1', title: 'Weekly Sync', ai_summary: LONG_SUMMARY }))
    expect(res.status).toBe(200)
    expect(hoisted.inngestSend).toHaveBeenCalledExactlyOnceWith({
      name: 'claim/extract-from-source',
      data: {
        workspaceId: 'ws-row',
        userId: 'user-1',
        memberId: 'member-1',
        sourceType: 'capture',
        sourceId: 'cap-1',
        sourceLabel: 'Meeting: Weekly Sync',
      },
    })
  })

  it("opts in to the ChatGPT plan: a free user's capture is indexed, its extraction on their plan", async () => {
    await POST(request({ captureId: 'cap-1', title: 'Weekly Sync', ai_summary: LONG_SUMMARY }))
    expect(usage.check).toHaveBeenCalledWith('user-1', undefined, { chatgptPlan: true })
  })

  it('skips the send for short bodies (auto-record blips)', async () => {
    captureRow = { ...captureRow!, ai_summary: 'too short', content: null }
    const res = await POST(request({ captureId: 'cap-1' }))
    expect(res.status).toBe(200)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('skips the send for demo captures', async () => {
    captureRow = { ...captureRow!, metadata: { demo: true } }
    const res = await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    expect(res.status).toBe(200)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a send failure never fails the request', async () => {
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const res = await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    expect(res.status).toBe(200)
    expect(hoisted.indexCapture).toHaveBeenCalledOnce()
  })

  it('sends BEFORE indexing — an indexing failure cannot strand extraction', async () => {
    hoisted.indexCapture.mockRejectedValueOnce(new Error('23502 not-null violation'))
    const res = await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    expect(res.status).toBe(500)
    expect(hoisted.inngestSend).toHaveBeenCalledOnce()
  })

  it('memberId falls back to null when the user has no member row', async () => {
    memberRow = null
    await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    const sent = hoisted.inngestSend.mock.calls[0][0] as { data: { memberId: string | null } }
    expect(sent.data.memberId).toBeNull()
  })

  it('ignores a client-supplied workspace_id — the capture row is the source of truth', async () => {
    // A malicious/stale client passes a foreign workspace_id; it must not
    // override the capture row's real workspace for extraction or indexing.
    await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY, workspace_id: 'ws-attacker' }))
    const sent = hoisted.inngestSend.mock.calls[0][0] as { data: { workspaceId: string } }
    expect(sent.data.workspaceId).toBe('ws-row')
    // indexCapture(supabase, id, userId, projectId, chunks, wsId)
    expect(hoisted.indexCapture.mock.calls[0][5]).toBe('ws-row')
  })

  it('falls back to the cookie workspace when the capture row has no workspace_id', async () => {
    captureRow = { ...captureRow!, workspace_id: null }
    await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY, workspace_id: 'ws-attacker' }))
    const sent = hoisted.inngestSend.mock.calls[0][0] as { data: { workspaceId: string } }
    expect(sent.data.workspaceId).toBe('ws-cookie')
  })
})

describe('POST /api/ai/index-content — project_id fallback (mig 188)', () => {
  it('uses the capture row project_id when the payload omits it', async () => {
    await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    // indexCapture(supabase, id, userId, projectId, chunks, wsId)
    expect(hoisted.indexCapture.mock.calls[0][3]).toBe('proj-row')
  })

  it('payload project_id still wins when provided', async () => {
    await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY, project_id: 'proj-payload' }))
    expect(hoisted.indexCapture.mock.calls[0][3]).toBe('proj-payload')
  })

  it('passes null when neither payload nor row has a project', async () => {
    captureRow = { ...captureRow!, project_id: null }
    await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    expect(hoisted.indexCapture.mock.calls[0][3]).toBeNull()
  })
})


describe('POST /api/ai/index-content — capture_processed (the no-batch stop path; A4)', () => {
  it('emits flow/capture.processed for the row-resolved workspace only when the body says so', async () => {
    const res = await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY, capture_processed: true }))
    expect(res.status).toBe(200)
    expect(hoisted.emitCaptureProcessed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: 'ws-row', captureId: 'cap-1' }),
    )
  })

  it('a plain call (batch paths, the cron) never emits it', async () => {
    const res = await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY }))
    expect(res.status).toBe(200)
    expect(hoisted.emitCaptureProcessed).not.toHaveBeenCalled()
  })

  it('a truthy non-boolean flag is not a flag', async () => {
    const res = await POST(request({ captureId: 'cap-1', ai_summary: LONG_SUMMARY, capture_processed: 'yes' }))
    expect(res.status).toBe(200)
    expect(hoisted.emitCaptureProcessed).not.toHaveBeenCalled()
  })
})
