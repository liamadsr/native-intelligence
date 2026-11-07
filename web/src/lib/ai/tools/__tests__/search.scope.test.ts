/**
 * The agent picks each search's scope (src/lib/ai/tools/search-scope.ts): the
 * person's "My captures" picker is gone, and nothing about it reaches the tools.
 *
 *   - in the main chat's toolset (searchDefaultWindow 'past_4_weeks') `find`
 *     and `deep_search` search the past 4 weeks unless the agent widens them
 *     (`since`, `all_time`); every other toolset defaults to all time, as before;
 *     an `until` alone has no lower bound;
 *   - claims are never windowed by default: only an explicit since / until;
 *   - `find`'s recency boost is not raised by the default window (that would
 *     count recency twice), only by a window the agent chose;
 *   - deep_search searches attachments unless `types` leaves them out, and
 *     transcript passages by default everywhere but the main chat, where the
 *     first pass is summaries only (each the picker's own default) until
 *     `include_transcripts`;
 *   - each result states the scope it used;
 *   - PARITY: every outcome the picker could produce (recent / all ×
 *     transcripts × attachments) is reachable through deep_search's options,
 *     with the same RPC calls the picker-driven path made (the reference below
 *     is that path's behaviour, written out).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createSearchTools } from '../search'
import { createTools } from '../index'
import { DEFAULT_SEARCH_WINDOW_MS, type SearchDefaultWindow } from '../search-scope'

vi.mock('@/lib/ai/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/embeddings')>()),
  embed: vi.fn(async () => [0.1, 0.2]),
}))
vi.mock('@/lib/ai/gemini-embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini-embeddings')>()),
  embedQuery: vi.fn(async () => [0.3]),
}))
vi.mock('@/lib/email/email-search-service', () => ({ searchEmails: vi.fn(async () => ({ results: [] })) }))
vi.mock('@/lib/email/email-context-service', () => ({ searchEmailsWithContext: vi.fn(async () => []) }))
vi.mock('@/lib/ai/decisions/retrieval-filter', () => ({ filterRetrievalPassages: vi.fn(async () => ({ irrelevantIds: new Set() })) }))

const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const NOW = new Date('2026-10-08T12:00:00Z')
const FOUR_WEEKS_AGO = new Date(NOW.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString()

/** Any query chain resolves empty; every RPC is recorded and answers empty. */
function emptyChain(): unknown {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  for (const m of ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'gte', 'lte', 'neq']) chain[m] = vi.fn(self)
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
  chain.single = vi.fn(async () => ({ data: null, error: null }))
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
  return chain
}

type RpcCall = [string, Record<string, unknown>]

function fakeSupabase() {
  const rpc = vi.fn(async (_name: string, _args?: Record<string, unknown>) => ({ data: [], error: null }))
  return { rpc, supabase: { from: vi.fn(() => emptyChain()), rpc, storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) } } }
}

/**
 * Run a search tool the way the model calls it: through its zod schema
 * (defaults applied). `chat` builds the main chat's toolset (the past-4-weeks
 * default); otherwise the all-time default every other surface has.
 */
async function run(toolName: 'find' | 'deep_search', input: Record<string, unknown>, defaultWindow: SearchDefaultWindow = 'past_4_weeks') {
  const { rpc, supabase } = fakeSupabase()
  const t = createSearchTools('user-1', supabase as never, 'ws-1', false, defaultWindow)[toolName]
  const parsed = (t.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({ query: 'pricing', ...input })
  const result = (await t.execute!(parsed as never, EXEC_OPTS)) as Record<string, unknown>
  const calls = rpc.mock.calls.map((c) => [c[0], c[1] ?? {}] as RpcCall)
  return {
    result,
    calls,
    args: (name: string) => calls.find((c) => c[0] === name)?.[1],
    all: (name: string) => calls.filter((c) => c[0] === name).map((c) => c[1]),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('outside the main chat the default is all time, as before', () => {
  it('find: one hybrid_search, unbounded', async () => {
    const { result, all } = await run('find', {}, 'all_time')
    expect(all('hybrid_search')).toHaveLength(1)
    expect(all('hybrid_search')[0]).toMatchObject({ p_since: null, p_until: null, p_types: ['claim', 'capture', 'document'] })
    expect(result.scope).toEqual({ window: 'all_time', since: null, until: null, claims_windowed: false, documents_windowed: false, transcripts: false, attachments: false })
  })

  it('deep_search: captures from all history, transcript passages and attachments included', async () => {
    const { result, args } = await run('deep_search', {}, 'all_time')
    expect(args('rag_search')).toMatchObject({ p_created_after: null, p_include_transcripts: true })
    expect(args('attachment_rag_search')).toBeTruthy()
    expect(result.scope).toMatchObject({ window: 'all_time', since: null, transcripts: true, attachments: true })
  })

  it('deep_search: the agent can still ask for summaries only, without attachments', async () => {
    const { result, args } = await run('deep_search', { include_transcripts: false, types: ['captures', 'claims'] }, 'all_time')
    expect(args('rag_search')).toMatchObject({ p_include_transcripts: false })
    expect(args('attachment_rag_search')).toBeUndefined()
    expect(result.scope).toMatchObject({ transcripts: false, attachments: false })
  })

  it('createTools defaults to all time; only an explicit searchDefaultWindow narrows it', async () => {
    const plain = fakeSupabase()
    const tools = createTools('user-1', plain.supabase as never, 'ws-1') as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>
    await tools.find.execute({ query: 'q', limit: 15 }, EXEC_OPTS)
    expect(plain.rpc.mock.calls.find((c) => c[0] === 'hybrid_search')?.[1]).toMatchObject({ p_since: null })
    const chat = fakeSupabase()
    const chatTools = createTools('user-1', chat.supabase as never, 'ws-1', undefined, { searchDefaultWindow: 'past_4_weeks' }) as unknown as typeof tools
    await chatTools.find.execute({ query: 'q', limit: 15 }, EXEC_OPTS)
    expect(chat.rpc.mock.calls.map((c) => c[1]?.p_since)).toContain(FOUR_WEEKS_AGO)
  })
})

describe('in the main chat the default window is the past 4 weeks', () => {
  it('is 28 days', () => {
    expect(DEFAULT_SEARCH_WINDOW_MS).toBe(28 * 24 * 60 * 60 * 1000)
  })

  it('deep_search: captures from the last 4 weeks, summaries only, attachments included (the picker\'s default)', async () => {
    const { result, args } = await run('deep_search', {})
    expect(args('rag_search')).toMatchObject({ p_created_after: FOUR_WEEKS_AGO, p_include_transcripts: false })
    expect(args('attachment_rag_search')).toBeTruthy()
    expect(result.scope).toEqual({ window: 'past_4_weeks', since: FOUR_WEEKS_AGO, until: null, claims_windowed: false, transcripts: false, attachments: true })
  })

  it('find: captures bounded to the last 4 weeks, claims and documents searched in full, recency NOT auto-raised', async () => {
    const { result, all } = await run('find', {})
    const calls = all('hybrid_search')
    expect(calls).toHaveLength(2)
    expect(calls.find((c) => (c.p_types as string[]).includes('claim'))).toMatchObject({ p_types: ['claim', 'document'], p_since: null, p_until: null, p_w_recent: 0.5 })
    expect(calls.find((c) => !(c.p_types as string[]).includes('claim'))).toMatchObject({ p_types: ['capture'], p_since: FOUR_WEEKS_AGO, p_until: null, p_w_recent: 0.5 })
    expect(result.scope).toEqual({ window: 'past_4_weeks', since: FOUR_WEEKS_AGO, until: null, claims_windowed: false, documents_windowed: false, transcripts: false, attachments: false })
  })

  it('find with documents alone: one unbounded call, whatever their age (documents phase 1)', async () => {
    const { all, result } = await run('find', { types: ['document'] })
    expect(all('hybrid_search')).toEqual([expect.objectContaining({ p_types: ['document'], p_since: null, p_until: null })])
    expect(result.scope).toMatchObject({ documents_windowed: false })
  })

  it('find with an explicit since: documents take it too (by when their text last changed, in SQL)', async () => {
    const { all, result } = await run('find', { types: ['document', 'capture'], since: '2026-09-01' })
    expect(all('hybrid_search')).toEqual([expect.objectContaining({ p_types: ['document', 'capture'], p_since: expect.stringMatching(/^2026-09-01/) })])
    expect(result.scope).toMatchObject({ window: 'range', documents_windowed: true })
  })

  it('find: emails take the default window too', async () => {
    const { searchEmails } = await import('@/lib/email/email-search-service')
    vi.mocked(searchEmails).mockClear()
    await run('find', { types: ['email'] })
    expect(vi.mocked(searchEmails).mock.calls[0][2]).toMatchObject({ after: FOUR_WEEKS_AGO })
  })

  it('find with claims alone: one unbounded call', async () => {
    const { all, result } = await run('find', { types: ['claim'] })
    expect(all('hybrid_search')).toEqual([expect.objectContaining({ p_types: ['claim'], p_since: null, p_until: null })])
    expect(result.scope).toMatchObject({ claims_windowed: false })
  })
})

describe('claims take only an explicit since / until', () => {
  it('find: an explicit since filters claims with everything else (one call)', async () => {
    const { all, result } = await run('find', { since: '2026-09-01' })
    expect(all('hybrid_search')).toEqual([expect.objectContaining({ p_types: ['claim', 'capture', 'document'], p_since: '2026-09-01T00:00:00.000Z' })])
    expect(result.scope).toMatchObject({ window: 'range', claims_windowed: true })
  })

  it('deep_search: no event bounds by default, the explicit ones when given', async () => {
    const plain = await run('deep_search', {})
    expect(plain.args('match_claims')).toMatchObject({ p_event_after: null, p_event_before: null })
    expect(plain.result.scope).toMatchObject({ claims_windowed: false })
    const ranged = await run('deep_search', { since: '2026-09-01', until: '2026-09-30' })
    expect(ranged.args('match_claims')!.p_event_after).toBe('2026-09-01T00:00:00.000Z')
    expect(ranged.args('match_claims')!.p_event_before).not.toBeNull()
    expect(ranged.result.scope).toMatchObject({ claims_windowed: true })
  })
})

describe('the agent widens', () => {
  it('deep_search all_time: no lower bound', async () => {
    const { result, args } = await run('deep_search', { all_time: true })
    expect(args('rag_search')).toMatchObject({ p_created_after: null })
    expect(result.scope).toMatchObject({ window: 'all_time', since: null })
  })

  it('find all_time: no bounds, recency at its base weight', async () => {
    const { result, args } = await run('find', { all_time: true })
    expect(args('hybrid_search')).toMatchObject({ p_since: null, p_until: null, p_w_recent: 0.5 })
    expect(result.scope).toMatchObject({ window: 'all_time', since: null, until: null, claims_windowed: false })
  })

  it('a since preset replaces the default window (find raises recency for a tight window it chose)', async () => {
    const tight = await run('find', { since: 'past_7_days' })
    expect(tight.args('hybrid_search')!.p_since).not.toBe(FOUR_WEEKS_AGO)
    expect(tight.args('hybrid_search')).toMatchObject({ p_w_recent: 1.0 })
    expect(tight.result.scope).toMatchObject({ window: 'range' })
    const wide = await run('find', { since: '2025-01-01' })
    expect(wide.args('hybrid_search')).toMatchObject({ p_since: '2025-01-01T00:00:00.000Z', p_w_recent: 0.5 })
    const deep = await run('deep_search', { since: '2025-01-01' })
    expect(deep.args('rag_search')).toMatchObject({ p_created_after: '2025-01-01T00:00:00.000Z' })
    expect(deep.result.scope).toMatchObject({ window: 'range', since: '2025-01-01T00:00:00.000Z' })
  })

  it('an until alone has no lower bound: "before March" is not cut to the last 4 weeks', async () => {
    const { result, args } = await run('find', { until: '2026-03-01' })
    expect(args('hybrid_search')).toMatchObject({ p_since: null, p_until: '2026-03-01T00:00:00.000Z' })
    expect(result.scope).toMatchObject({ window: 'range', since: null, until: '2026-03-01T00:00:00.000Z' })
  })
})

describe('the agent widens to transcripts and attachments', () => {
  it('include_transcripts reaches rag_search', async () => {
    const { result, args } = await run('deep_search', { include_transcripts: true })
    expect(args('rag_search')).toMatchObject({ p_include_transcripts: true })
    expect(result.scope).toMatchObject({ transcripts: true })
  })

  it('deep_search attachments via types', async () => {
    const { result, args } = await run('deep_search', { types: ['captures', 'attachments', 'claims'] })
    expect(args('attachment_rag_search')).toBeTruthy()
    expect(result.scope).toMatchObject({ attachments: true })
  })

  it('find attachments via types, inside the same window', async () => {
    const { result, args } = await run('find', { types: ['claim', 'capture', 'document', 'attachment'] })
    expect(args('hybrid_search_attachments')).toMatchObject({ p_since: FOUR_WEEKS_AGO })
    expect(result.scope).toMatchObject({ attachments: true, transcripts: false })
  })
})

// ── Parity with the removed picker ──────────────────────────────────────────

interface LegacyPicker {
  timeWindow: 'recent' | 'all'
  includeTranscripts: boolean
  includeAttachments: boolean
}

/**
 * The RPC calls the picker-driven deep_search made for a plain query (no
 * since / until / types / expanded_search), as that code read: rag_search with
 * the window's lower bound and the transcript switch, attachment_rag_search
 * only with attachments on, match_claims with no event bounds (the window never
 * reached claims).
 */
function legacyCalls(p: LegacyPicker): RpcCall[] {
  const calls: RpcCall[] = [
    ['rag_search', {
      p_user_id: 'user-1', p_project_ids: [], p_note_ids: [], p_embedding: JSON.stringify([0.1, 0.2]), p_limit: 10, p_threshold: 0.3,
      p_workspace_id: 'ws-1', p_created_after: p.timeWindow === 'recent' ? FOUR_WEEKS_AGO : null, p_include_transcripts: p.includeTranscripts,
    }],
  ]
  if (p.includeAttachments) {
    calls.push(['attachment_rag_search', {
      p_user_id: 'user-1', p_embedding: JSON.stringify([0.3]), p_workspace_id: 'ws-1', p_project_ids: [], p_limit: 10, p_threshold: 0.3,
    }])
  }
  calls.push(['match_claims', {
    p_workspace_id: 'ws-1', p_embedding: '[0.1,0.2]', p_limit: 10, p_threshold: 0.3, p_type: null, p_confirmation: null, p_status: 'active',
    p_min_confidence: null, p_event_after: null, p_event_before: null, p_requesting_user_id: 'user-1',
  }])
  return calls
}

/** The deep_search options that reproduce a picker setting. */
function optionsFor(p: LegacyPicker): Record<string, unknown> {
  return {
    ...(p.timeWindow === 'all' ? { all_time: true } : {}),
    ...(p.includeTranscripts ? { include_transcripts: true } : {}),
    ...(p.includeAttachments ? {} : { types: ['captures', 'claims'] }),
  }
}

const sortCalls = (calls: RpcCall[]) => [...calls].sort((a, b) => a[0].localeCompare(b[0]))

describe('parity: every picker setting is reachable through the main chat\'s deep_search options, with the same RPC calls', () => {
  const combos: LegacyPicker[] = []
  for (const timeWindow of ['recent', 'all'] as const)
    for (const includeTranscripts of [false, true])
      for (const includeAttachments of [false, true]) combos.push({ timeWindow, includeTranscripts, includeAttachments })

  it.each(combos)('%o', async (picker) => {
    const { calls, result } = await run('deep_search', optionsFor(picker))
    expect(sortCalls(calls)).toEqual(sortCalls(legacyCalls(picker)))
    // The same result shape, plus the scope it used.
    expect(Object.keys(result).sort()).toEqual(['attachments', 'captures', 'claims', 'count', 'scope', 'searchMeta', 'success'])
    expect(result.scope).toEqual({
      window: picker.timeWindow === 'recent' ? 'past_4_weeks' : 'all_time',
      since: picker.timeWindow === 'recent' ? FOUR_WEEKS_AGO : null,
      until: null,
      claims_windowed: false,
      transcripts: picker.includeTranscripts,
      attachments: picker.includeAttachments,
    })
    expect(result.searchMeta).toMatchObject({
      createdAfter: picker.timeWindow === 'recent' ? FOUR_WEEKS_AGO : null,
      expandedSearch: picker.timeWindow === 'all',
    })
  })
})
