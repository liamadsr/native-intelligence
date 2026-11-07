/**
 * Tests for indexCaptureFinished — the shared capture-finished seam that both
 * POST /api/ai/index-content and the index-reconciler cron run.
 *
 * The regression this file exists for: the cron passes ONLY `captureRow` (no
 * bare title/content/summary params). The extraction guard already fell back to
 * the row, but the chunk-building section read the bare params alone, so every
 * cron heal built an empty body and returned a silent { chunksCreated: 0 } —
 * a straggler could never heal. PROD had 11 such captures unhealed across 46+
 * hourly ticks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  inngestSend: vi.fn(async (..._args: unknown[]) => ({ ids: ['evt-1'] })),
  indexCapture: vi.fn(async (..._args: unknown[]) => ({ chunksCreated: 3 })),
  emitCaptureProcessed: vi.fn((_args: unknown) => {}),
}))
vi.mock('@/lib/flows/emit-capture-processed', () => ({
  emitCaptureProcessed: hoisted.emitCaptureProcessed,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: hoisted.inngestSend,
    // capture-ingest.ts defines an Inngest function at module load (imported
    // for MIN_SUMMARY_CHARS) — stub so the import chain doesn't throw.
    createFunction: vi.fn(() => ({})),
  },
}))
vi.mock('@/lib/ai/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/embeddings')>()
  return { ...actual, indexCapture: hoisted.indexCapture }
})

const { indexCaptureFinished } = await import('@/lib/ai/index-capture-finished')

const LONG_SUMMARY = 'A real meeting summary sentence. '.repeat(15) // ~495 chars
const TRANSCRIPT = 'Alice: we should ship on Friday. Bob: agreed.'

/** Minimal supabase double: proposed_change resolves empty, member resolves one row. */
function makeSupabase(proposedChanges: Array<Record<string, unknown>> = []) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const proxy: unknown = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === 'maybeSingle') {
            if (table === 'member') return async () => ({ data: { id: 'member-1' }, error: null })
            return async () => ({ data: null, error: null })
          }
          if (prop === 'then') {
            return (cb: (v: unknown) => unknown) =>
              Promise.resolve({ data: proposedChanges, error: null }).then(cb)
          }
          return () => proxy
        },
      })
      return proxy
    },
  } as never
}

type IndexCall = [unknown, string, string, string | null, Array<{ text: string; source: string }>, string | null]

beforeEach(() => {
  hoisted.inngestSend.mockClear()
  hoisted.indexCapture.mockClear()
  hoisted.indexCapture.mockResolvedValue({ chunksCreated: 3 })
  hoisted.emitCaptureProcessed.mockClear()
})

describe('indexCaptureFinished — cron path (captureRow only, no bare params)', () => {
  it('indexes the ROW body when no bare params are supplied', async () => {
    const result = await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-cron',
      captureRow: {
        workspace_id: 'ws-1',
        project_id: 'proj-1',
        title: 'APIM — mapping file configuration',
        ai_summary: LONG_SUMMARY,
        content: TRANSCRIPT,
        metadata: null,
      },
      userId: 'owner-1',
      workspaceId: 'ws-1',
    })

    // The bug: this used to be { chunksCreated: 0 } with indexCapture never called.
    expect(hoisted.indexCapture).toHaveBeenCalledOnce()
    expect(result).toEqual({ chunksCreated: 3 })

    const [, captureId, userId, projectId, chunks, wsId] =
      hoisted.indexCapture.mock.calls[0] as unknown as IndexCall
    expect(captureId).toBe('cap-cron')
    expect(userId).toBe('owner-1')
    expect(projectId).toBe('proj-1')
    expect(wsId).toBe('ws-1')

    expect(chunks[0].source).toBe('summary')
    expect(chunks[0].text).toContain('APIM — mapping file configuration')
    expect(chunks[0].text).toContain('A real meeting summary sentence.')
    expect(chunks[1]).toEqual({ text: TRANSCRIPT, source: 'transcript' })
  })

  it('still sends claim/extract-from-source, labelled from the row title', async () => {
    await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-cron',
      captureRow: {
        workspace_id: 'ws-1',
        title: 'Weekly Sync',
        ai_summary: LONG_SUMMARY,
        content: null,
        metadata: null,
      },
      userId: 'owner-1',
      workspaceId: 'ws-1',
    })
    expect(hoisted.inngestSend).toHaveBeenCalledExactlyOnceWith({
      name: 'claim/extract-from-source',
      data: {
        workspaceId: 'ws-1',
        userId: 'owner-1',
        memberId: 'member-1',
        sourceType: 'capture',
        sourceId: 'cap-cron',
        sourceLabel: 'Meeting: Weekly Sync',
      },
    })
  })

  it('folds proposed-change text into the row-derived summary chunk', async () => {
    await indexCaptureFinished({
      supabase: makeSupabase([
        {
          display_text: 'Ship the billing rework',
          title: 'Ship the billing rework',
          description: 'Land by Friday',
          reasoning: null,
          entity_type: 'action',
        },
      ]),
      captureId: 'cap-cron',
      captureRow: {
        workspace_id: 'ws-1',
        title: 'Weekly Sync',
        ai_summary: LONG_SUMMARY,
        content: null,
        metadata: null,
      },
      userId: 'owner-1',
      workspaceId: 'ws-1',
    })
    const [, , , , chunks] = hoisted.indexCapture.mock.calls[0] as unknown as IndexCall
    expect(chunks[0].text).toContain('Weekly Sync')
    expect(chunks[0].text).toContain('Proposed Changes:')
    expect(chunks[0].text).toContain('[action] Ship the billing rework — Land by Friday')
  })

  it('returns { chunksCreated: 0 } without indexing when the row carries no text at all', async () => {
    const result = await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-empty',
      captureRow: { workspace_id: 'ws-1', title: null, ai_summary: null, content: null, metadata: null },
      userId: 'owner-1',
      workspaceId: 'ws-1',
    })
    expect(result).toEqual({ chunksCreated: 0 })
    expect(hoisted.indexCapture).not.toHaveBeenCalled()
  })
})

describe('indexCaptureFinished — route path parity', () => {
  it('bare params still index when the row is null (legacy payload-only call)', async () => {
    await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-route',
      captureRow: null,
      userId: 'user-1',
      workspaceId: 'ws-1',
      title: 'Payload Title',
      ai_summary: LONG_SUMMARY,
      content: TRANSCRIPT,
    })
    const [, , , , chunks] = hoisted.indexCapture.mock.calls[0] as unknown as IndexCall
    expect(chunks[0].text).toContain('Payload Title')
    expect(chunks[0].text).toContain('A real meeting summary sentence.')
    expect(chunks[1]).toEqual({ text: TRANSCRIPT, source: 'transcript' })
  })

  it('the row wins over a stale bare param, matching the extraction guard', async () => {
    await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-route',
      captureRow: {
        workspace_id: 'ws-1',
        title: 'Row Title',
        ai_summary: LONG_SUMMARY,
        content: 'row transcript',
        metadata: null,
      },
      userId: 'user-1',
      workspaceId: 'ws-1',
      title: 'Stale Payload Title',
      ai_summary: 'stale payload summary',
      content: 'stale payload transcript',
    })
    const [, , , , chunks] = hoisted.indexCapture.mock.calls[0] as unknown as IndexCall
    expect(chunks[0].text).toContain('Row Title')
    expect(chunks[0].text).not.toContain('Stale Payload Title')
    expect(chunks[0].text).not.toContain('stale payload summary')
    expect(chunks[1]).toEqual({ text: 'row transcript', source: 'transcript' })
  })

  it('a legacy `summary` param still indexes when neither row nor ai_summary has text', async () => {
    await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-legacy',
      captureRow: { workspace_id: 'ws-1', title: null, ai_summary: null, content: null, metadata: null },
      userId: 'user-1',
      workspaceId: 'ws-1',
      summary: 'Old-style summary body.',
    })
    const [, , , , chunks] = hoisted.indexCapture.mock.calls[0] as unknown as IndexCall
    expect(chunks[0]).toEqual({ text: 'Old-style summary body.', source: 'summary' })
  })

  it('skips the extraction send for demo captures but still indexes', async () => {
    await indexCaptureFinished({
      supabase: makeSupabase(),
      captureId: 'cap-demo',
      captureRow: {
        workspace_id: 'ws-1',
        title: 'Demo',
        ai_summary: LONG_SUMMARY,
        content: null,
        metadata: { demo: true },
      },
      userId: 'user-1',
      workspaceId: 'ws-1',
    })
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    expect(hoisted.indexCapture).toHaveBeenCalledOnce()
  })
})


describe('indexCaptureFinished — captureProcessed (a live-mode capture no batch pass closes; A4)', () => {
  /** A supabase double that also records `captures` updates (the batch_processed_at stamp). */
  function makeSupabaseWithUpdates() {
    const updates: Array<{ table: string; patch: Record<string, unknown> }> = []
    const supabase = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {}
        const proxy: unknown = new Proxy(chain, {
          get(_t, prop: string) {
            if (prop === 'maybeSingle') {
              if (table === 'member') return async () => ({ data: { id: 'member-1' }, error: null })
              return async () => ({ data: null, error: null })
            }
            if (prop === 'update') {
              return (patch: Record<string, unknown>) => {
                updates.push({ table, patch })
                return proxy
              }
            }
            if (prop === 'then') {
              return (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb)
            }
            return () => proxy
          },
        })
        return proxy
      },
    } as never
    return { supabase, updates }
  }

  const row = {
    workspace_id: 'ws-1',
    project_id: 'proj-1',
    title: 'Live call',
    ai_summary: LONG_SUMMARY,
    content: TRANSCRIPT,
    metadata: null,
  }

  it('emits flow/capture.processed and stamps batch_processed_at when the caller says the record is final', async () => {
    const { supabase, updates } = makeSupabaseWithUpdates()
    await indexCaptureFinished({ supabase, captureId: 'cap-live', captureRow: row, userId: 'u', workspaceId: 'ws-1', captureProcessed: true })
    await Promise.resolve()
    expect(hoisted.emitCaptureProcessed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: 'ws-1', captureId: 'cap-live' }),
    )
    const stamp = updates.find((u) => u.table === 'captures' && typeof u.patch.batch_processed_at === 'string')
    expect(stamp).toBeDefined()
    // Indexing and the knowledge send still happen.
    expect(hoisted.indexCapture).toHaveBeenCalledOnce()
    expect(hoisted.inngestSend).toHaveBeenCalledOnce()
  })

  it('does NOT emit by default (the batch finalize / cron paths own their own emit)', async () => {
    const { supabase, updates } = makeSupabaseWithUpdates()
    await indexCaptureFinished({ supabase, captureId: 'cap-batch', captureRow: row, userId: 'u', workspaceId: 'ws-1' })
    expect(hoisted.emitCaptureProcessed).not.toHaveBeenCalled()
    expect(updates.find((u) => u.table === 'captures')).toBeUndefined()
  })

  it('never fires loops for a demo or an eval capture, even when asked', async () => {
    const { supabase } = makeSupabaseWithUpdates()
    await indexCaptureFinished({ supabase, captureId: 'cap-demo', captureRow: { ...row, metadata: { demo: true } }, userId: 'u', workspaceId: 'ws-1', captureProcessed: true })
    await indexCaptureFinished({ supabase, captureId: 'cap-eval', captureRow: { ...row, is_eval: true }, userId: 'u', workspaceId: 'ws-1', captureProcessed: true })
    expect(hoisted.emitCaptureProcessed).not.toHaveBeenCalled()
  })
})
