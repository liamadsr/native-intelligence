import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/capture-reindex.ts — the debounced replacement for
 * the PATCH route's old inline reindexCaptureBestEffort (perf audit finding 3d).
 *
 * Invariants locked in:
 *  - triggered by capture/reindex.requested with a per-capture 60s debounce
 *    (edit bursts coalesce into ONE embed run),
 *  - reads the row's CURRENT values from the DB (never an event payload) and
 *    indexes with the exact tagged-chunk shape the inline path produced:
 *    summary chunk (title + ai_summary/summary + "Proposed Changes:" section)
 *    plus a 'transcript'-tagged content chunk,
 *  - a capture deleted before the debounced run is a clean skip,
 *  - a capture with nothing indexable CLEARS capture_chunks (stale vectors
 *    must not keep surfacing text that no longer exists),
 *  - after a successful re-index it ALSO fires claim/extract-from-source under
 *    index-capture-finished.ts's guards (demo skip, MIN_SUMMARY_CHARS floor,
 *    best-effort). Without it a manual edit refreshed chunks while extraction
 *    never ran — PROD capture d79b0039 had 17 healthy chunks and zero claims.
 */

// ---- Hoisted mocks --------------------------------------------------------

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  indexCaptureSpy: vi.fn(),
  inngestSend: vi.fn(async (..._args: unknown[]) => ({ ids: ['evt-1'] })),
}))

// Capture the Inngest handler + config so tests can invoke it directly. The
// module also imports capture-ingest (for MIN_SUMMARY_CHARS), which defines its
// own functions at load — match on the id so those don't clobber the capture.
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: hoisted.inngestSend,
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      if (config.id === 'capture-reindex') {
        hoisted.config = config
        hoisted.handler = fn
      }
      return { id: config.id }
    },
  },
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ from: vi.fn() }),
}))

// indexCapture is stubbed as a spy (no embedding API); buildIndexableText's
// stub mirrors the real join so the summary-chunk composition tests are honest.
vi.mock('@/lib/ai/embeddings', () => ({
  indexCapture: (...args: unknown[]) => hoisted.indexCaptureSpy(...args),
  buildIndexableText: (note: { title?: string; ai_summary?: string; summary?: string; content?: string }) =>
    [note.title, note.ai_summary || note.summary, note.content].filter(Boolean).join('\n\n'),
}))

// Evaluate the module so createFunction runs and the handler is captured.
const mod = await import('@/lib/inngest/capture-reindex')

// ---- Helpers ---------------------------------------------------------------

const HAPPY_ROW = {
  title: 'Weekly Sync',
  content: 'Discussed the Q3 roadmap and hiring plan.',
  ai_summary: 'Team aligned on roadmap.',
  summary: null,
  project_id: 'proj-1',
}

/**
 * Chainable fake supabase: `.from(table)` routes to per-table stubs. The
 * capture_chunks delete is recorded so the clear-on-empty invariant is
 * assertable.
 */
function makeSupabase(rows: {
  captures?: Record<string, unknown> | null
  proposedChanges?: Record<string, unknown>[]
  member?: { id: string } | null
}) {
  const chunksDeleteSpy = vi.fn()
  const supabase = {
    from: (table: string) => {
      if (table === 'captures') {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.maybeSingle = () => Promise.resolve({ data: rows.captures ?? null })
        return q
      }
      if (table === 'proposed_change') {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.in = () => Promise.resolve({ data: rows.proposedChanges ?? [] })
        return q
      }
      if (table === 'capture_chunks') {
        return {
          delete: () => ({
            eq: (col: string, val: string) => {
              chunksDeleteSpy(col, val)
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === 'member') {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.maybeSingle = () => Promise.resolve({ data: rows.member ?? null })
        return q
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
  return { supabase, chunksDeleteSpy }
}

async function mockServiceClient(rows: Parameters<typeof makeSupabase>[0]) {
  const { supabase, chunksDeleteSpy } = makeSupabase(rows)
  const adminMod = await import('@/lib/admin')
  vi.spyOn(adminMod, 'getServiceClient').mockReturnValue(supabase as never)
  return { supabase, chunksDeleteSpy }
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      captureId: 'cap-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      ...overrides,
    },
  }
}

// ---- Tests -----------------------------------------------------------------

describe('captureReindex config', () => {
  it('is triggered by capture/reindex.requested with a per-capture 60s debounce', () => {
    expect(hoisted.config.id).toBe('capture-reindex')
    expect(hoisted.config.triggers).toEqual([{ event: 'capture/reindex.requested' }])
    // The debounce key is the whole point: a burst of debounced summary-save
    // PATCHes must coalesce into ONE embed run per capture.
    expect(hoisted.config.debounce).toEqual({ key: 'event.data.captureId', period: '60s' })
  })
})

describe('captureReindex handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    hoisted.indexCaptureSpy.mockReset()
    hoisted.indexCaptureSpy.mockResolvedValue({ chunksCreated: 2 })
    hoisted.inngestSend.mockReset()
    hoisted.inngestSend.mockResolvedValue({ ids: ['evt-1'] })
  })

  it('indexes the row\'s CURRENT values with the inline path\'s exact tagged-chunk shape', async () => {
    const { supabase } = await mockServiceClient({
      captures: HAPPY_ROW,
      proposedChanges: [
        {
          display_text: 'Ship the billing rework',
          title: 'Ship the billing rework',
          description: 'Land by Friday',
          reasoning: null,
          entity_type: 'action',
        },
      ],
    })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(hoisted.indexCaptureSpy).toHaveBeenCalledTimes(1)
    const [client, captureId, userId, projectId, chunks, workspaceId] =
      hoisted.indexCaptureSpy.mock.calls[0] as [unknown, string, string, string | null, { text: string; source: string }[], string]
    expect(client).toBe(supabase)
    expect(captureId).toBe('cap-1')
    expect(userId).toBe('u-1')
    expect(projectId).toBe('proj-1')
    expect(workspaceId).toBe('ws-1')
    // Chunk 1: summary text + the proposed-changes section.
    expect(chunks[0].source).toBe('summary')
    expect(chunks[0].text).toContain('Weekly Sync')
    expect(chunks[0].text).toContain('Team aligned on roadmap.')
    expect(chunks[0].text).toContain('Proposed Changes:')
    expect(chunks[0].text).toContain('[action] Ship the billing rework — Land by Friday')
    // Chunk 2: legacy content body, tagged 'transcript' (matches index-content).
    expect(chunks[1]).toEqual({ text: HAPPY_ROW.content, source: 'transcript' })
    expect(result).toMatchObject({ status: 'indexed', captureId: 'cap-1', chunksCreated: 2 })
  })

  it('skips cleanly when the capture was deleted before the debounced run', async () => {
    const { chunksDeleteSpy } = await mockServiceClient({ captures: null })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(result).toMatchObject({ status: 'skipped', reason: 'missing_capture' })
    expect(hoisted.indexCaptureSpy).not.toHaveBeenCalled()
    expect(chunksDeleteSpy).not.toHaveBeenCalled()
  })

  it('CLEARS capture_chunks when nothing indexable remains (no stale vectors)', async () => {
    const { chunksDeleteSpy } = await mockServiceClient({
      captures: { title: null, content: null, ai_summary: null, summary: null, project_id: null },
      proposedChanges: [],
    })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(hoisted.indexCaptureSpy).not.toHaveBeenCalled()
    expect(chunksDeleteSpy).toHaveBeenCalledWith('capture_id', 'cap-1')
    expect(result).toMatchObject({ status: 'cleared', captureId: 'cap-1' })
  })
})

describe('captureReindex — knowledge re-extraction', () => {
  const LONG_SUMMARY = 'A real meeting summary sentence. '.repeat(15) // ~495 chars
  const LONG_ROW = { ...HAPPY_ROW, ai_summary: LONG_SUMMARY, metadata: null }

  beforeEach(() => {
    vi.restoreAllMocks()
    hoisted.indexCaptureSpy.mockReset()
    hoisted.indexCaptureSpy.mockResolvedValue({ chunksCreated: 2 })
    hoisted.inngestSend.mockReset()
    hoisted.inngestSend.mockResolvedValue({ ids: ['evt-1'] })
  })

  it('sends claim/extract-from-source after a successful re-index', async () => {
    await mockServiceClient({ captures: LONG_ROW, proposedChanges: [], member: { id: 'member-7' } })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(result).toMatchObject({ status: 'indexed' })
    expect(hoisted.inngestSend).toHaveBeenCalledExactlyOnceWith({
      name: 'claim/extract-from-source',
      data: {
        workspaceId: 'ws-1',
        userId: 'u-1',
        memberId: 'member-7',
        sourceType: 'capture',
        sourceId: 'cap-1',
        sourceLabel: 'Meeting: Weekly Sync',
      },
    })
  })

  it('memberId falls back to null when the acting user has no member row', async () => {
    await mockServiceClient({ captures: LONG_ROW, proposedChanges: [], member: null })
    const step = createStepMock()

    await hoisted.handler({ event: makeEvent(), step })

    const sent = hoisted.inngestSend.mock.calls[0][0] as { data: { memberId: string | null } }
    expect(sent.data.memberId).toBeNull()
  })

  it('skips the send for demo captures (still re-indexes them)', async () => {
    await mockServiceClient({
      captures: { ...LONG_ROW, metadata: { demo: true } },
      proposedChanges: [],
      member: { id: 'member-7' },
    })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(result).toMatchObject({ status: 'indexed' })
    expect(hoisted.indexCaptureSpy).toHaveBeenCalledOnce()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('skips the send for bodies under MIN_SUMMARY_CHARS (auto-record blips)', async () => {
    // HAPPY_ROW's body is ~65 chars — well under the 200-char floor.
    await mockServiceClient({ captures: HAPPY_ROW, proposedChanges: [], member: { id: 'member-7' } })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(result).toMatchObject({ status: 'indexed' })
    expect(hoisted.indexCaptureSpy).toHaveBeenCalledOnce()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('never sends when the run cleared chunks instead of indexing', async () => {
    await mockServiceClient({
      captures: { title: null, content: null, ai_summary: null, summary: null, project_id: null, metadata: null },
      proposedChanges: [],
      member: { id: 'member-7' },
    })
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(result).toMatchObject({ status: 'cleared' })
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a send failure never fails the re-index (best-effort)', async () => {
    await mockServiceClient({ captures: LONG_ROW, proposedChanges: [], member: { id: 'member-7' } })
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const step = createStepMock()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(result).toMatchObject({ status: 'indexed', chunksCreated: 2 })
    warn.mockRestore()
  })
})

describe('buildCaptureReindexChunks', () => {
  const EMPTY_ROW = { title: null, content: null, ai_summary: null, summary: null, project_id: null }

  it('returns [] when the row and proposals carry no text', () => {
    expect(mod.buildCaptureReindexChunks(EMPTY_ROW, [])).toEqual([])
  })

  it('tags a content-only row as a transcript chunk', () => {
    const chunks = mod.buildCaptureReindexChunks(
      { ...EMPTY_ROW, content: 'Legacy meeting body.' },
      [],
    )
    expect(chunks).toEqual([{ text: 'Legacy meeting body.', source: 'transcript' }])
  })

  it('falls back to legacy summary when ai_summary is null', () => {
    const chunks = mod.buildCaptureReindexChunks(
      { ...EMPTY_ROW, title: 'Sync', summary: 'Old-style summary.' },
      [],
    )
    expect(chunks).toEqual([{ text: 'Sync\n\nOld-style summary.', source: 'summary' }])
  })

  it('builds a proposals-only summary chunk with the "Proposed Changes:" header', () => {
    const chunks = mod.buildCaptureReindexChunks(EMPTY_ROW, [
      { display_text: 'Do the thing', title: null, description: null, reasoning: null, entity_type: 'action' },
    ])
    expect(chunks).toEqual([
      { text: 'Proposed Changes:\n[action] Do the thing', source: 'summary' },
    ])
  })

  it('does not duplicate a proposal title equal to its display_text, and appends description + reasoning', () => {
    const chunks = mod.buildCaptureReindexChunks(EMPTY_ROW, [
      {
        display_text: 'Fix login bug',
        title: 'Fix login bug',
        description: 'Users locked out on SSO',
        reasoning: 'Mentioned twice in the call',
        entity_type: 'action',
      },
      {
        display_text: 'Q3 target',
        title: 'Raise Q3 revenue target',
        description: null,
        reasoning: null,
        entity_type: 'decision',
      },
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain(
      '[action] Fix login bug — Users locked out on SSO — Mentioned twice in the call',
    )
    // A DIFFERENT title is appended after the display text.
    expect(chunks[0].text).toContain('[decision] Q3 target — Raise Q3 revenue target')
  })
})
